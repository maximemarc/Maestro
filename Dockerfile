# Maestro en conteneur — optionnel.
#
# Rien n'oblige à passer par là : Maestro tourne très bien avec `npm start` sur
# la machine, et le confinement fin des agents se règle par agent (bac à sable
# de Claude Code, voir le README). Ce Dockerfile existe pour le cas où l'on veut
# une frontière dure autour de l'instance entière — un poste partagé, un VPS, un
# agent auquel on ne fait pas confiance du tout.
#
# Le durcissement ne vit pas ici mais dans docker-compose.yml : racine en
# lecture seule, capacités retirées, plafond de processus. Une image ne peut pas
# se durcir elle-même, c'est l'exécution qui le fait.

# --- Étape de construction -------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Les manifestes d'abord : une modification de code ne réinstalle pas tout.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --no-audit --no-fund

COPY tsconfig.base.json ./
COPY packages packages
RUN npm run build -w @maestro/web

# --- Étape d'exécution -----------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# git est nécessaire : Maestro relève les modifications produites par un agent
# dans son workspace (diff, patch, branche). Sans lui, cette partie se dégrade
# silencieusement en « répertoire non versionné ».
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages packages
# Chaque source porte son chemin complet : dans un COPY --from multi-sources,
# les suivantes sont résolues depuis la racine de l'étape, pas depuis la
# première. tsconfig.base.json est nécessaire — le tsconfig du serveur en hérite,
# et tsx le lit à l'exécution.
COPY --from=build /app/package.json /app/tsconfig.base.json ./

# Utilisateur non privilégié.
#
# L'image node fournit déjà `node` (uid 1000). On lui donne le répertoire de
# données et un HOME à lui : le CLI Claude embarqué par le SDK s'extrait dans un
# répertoire temporaire au démarrage, et n'écrirait nulle part sous un HOME
# appartenant à root.
ENV HOME=/home/node \
    MAESTRO_DATA_DIR=/data \
    MAESTRO_PORT=4520 \
    NODE_ENV=production
RUN mkdir -p /data && chown -R node:node /data /home/node
USER node

EXPOSE 4520

# Sonde de vivacité : /api/health ne demande pas de jeton, précisément pour
# qu'un orchestrateur puisse l'interroger sans en détenir un.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MAESTRO_PORT||4520)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
