# Maestro en conteneur.
#
# Ce que ce fichier ne peut pas faire, et qu'il faut savoir avant de le
# construire : **un conteneur n'hérite pas d'un abonnement Claude**.
# L'authentification par abonnement vit dans le répertoire personnel de la
# machine hôte et se rattache à sa session. Dans une image, l'authentification
# réaliste est une **clé d'API** (`ANTHROPIC_API_KEY`), ou le montage d'un
# profil déjà connecté — praticable, mais fragile dès que le jeton se rafraîchit.
#
# Ce qui se dégrade aussi, dit franchement :
#   - le **radar de sessions** ne voit que les processus du conteneur, donc rien
#     de ce qui tourne sur l'hôte ;
#   - le **bac à sable** d'agent exige bubblewrap et des capacités que ce
#     conteneur n'a pas ;
#   - le moteur **tmux** fonctionne, mais on ne s'y attache que depuis le
#     conteneur.
#
# Autrement dit : l'image sert un déploiement serveur piloté par clé d'API. Pour
# un poste de travail avec abonnement, le service utilisateur
# (`npm run service -- install`) est le bon outil.

# 🔒 Version épinglée, jamais `latest` : une image doit être reconstruisible à
# l'identique. En production, épingle plutôt par empreinte (`node:22-bookworm-slim@sha256:…`).
FROM node:22-bookworm-slim AS base

# git : les vues de modifications et l'export en branche s'appuient dessus.
# tmux : moteur de run interactif. ca-certificates : appels HTTPS sortants.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git tmux ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Dépendances et construction du front
# ---------------------------------------------------------------------------
FROM base AS build
WORKDIR /app

# Les manifestes d'abord : la couche d'installation n'est refaite que lorsqu'ils
# changent, pas à chaque modification de source.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci

COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# Image d'exécution
# ---------------------------------------------------------------------------
FROM base AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Le CLI Claude Code : le SDK d'agent l'exécute, il ne le remplace pas. Sans
# lui, chaque run échouerait au lancement.
RUN npm install -g @anthropic-ai/claude-code

# Les dépendances de développement sont conservées volontairement : le serveur
# s'exécute via tsx, qui en fait partie. Les élaguer casserait le démarrage.
COPY --from=build /app /app

# Utilisateur non privilégié. `node` existe déjà dans l'image de base ; on lui
# donne le répertoire de données, seul emplacement où Maestro écrit.
ENV MAESTRO_DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]

# Dans un conteneur, écouter sur la boucle locale rendrait le service
# injoignable de l'extérieur. C'est la **publication du port** qui borne
# l'exposition : `-p 127.0.0.1:4520:4520` pour rester sur l'hôte.
ENV MAESTRO_HOST=0.0.0.0
ENV MAESTRO_PORT=4520
EXPOSE 4520

# `/api/health` ne demande pas de jeton : c'est précisément ce qui permet à un
# orchestrateur de conteneurs de juger l'état sans détenir de secret.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MAESTRO_PORT||4520)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Signal par défaut : Maestro traite SIGTERM et clôt proprement ses sessions.
STOPSIGNAL SIGTERM

# Node est PID 1, et reçoit donc SIGTERM directement.
#
# Constaté en testant l'arrêt : avec `CMD ["npm", "start"]`, le conteneur sortait
# en **code 1**. npm en PID 1 ne relaie pas proprement le signal et rapporte la
# fin de son fils comme une erreur — un orchestrateur y voit un plantage à
# chaque arrêt demandé, et une politique de redémarrage sur échec boucle.
#
# Contrepartie : Node en PID 1 ne récolte pas les processus zombies, et Maestro
# lance des fils (claude, git, tmux). D'où `init: true` dans le compose, et
# `docker run --init` en lancement direct.
CMD ["node", "--env-file-if-exists=/app/.env", "--import", "tsx", "packages/server/src/index.ts"]
