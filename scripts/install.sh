#!/usr/bin/env bash
# Installation de Maestro en une commande.
#
#   curl -fsSL <url>/scripts/install.sh | bash
#
# ou, depuis un dépôt déjà cloné :
#
#   bash scripts/install.sh
#
# Le script ne fait rien d'irréversible : il contrôle les prérequis, installe
# les dépendances, construit l'interface et propose l'assistant de
# configuration. Il ne démarre pas le serveur — lancer un service en arrière-plan
# sans le dire n'est pas une installation, c'est une surprise.
set -euo pipefail

REPO_URL="${MAESTRO_REPO:-}"
TARGET="${MAESTRO_DIR:-$HOME/maestro}"
REQUIRED_NODE_MAJOR=22

bleu() { printf '\033[36m%s\033[0m\n' "$1"; }
vert() { printf '\033[32m%s\033[0m\n' "$1"; }
rouge() { printf '\033[31m%s\033[0m\n' "$1" >&2; }

echo
bleu "  🎛  Installation de Maestro"
echo

# -- Prérequis ---------------------------------------------------------------
#
# Contrôlés d'abord et tous ensemble : découvrir qu'il manque git après trois
# minutes de npm ci est une perte de temps évitable.
manquants=()
command -v node >/dev/null 2>&1 || manquants+=("node >= $REQUIRED_NODE_MAJOR")
command -v npm >/dev/null 2>&1 || manquants+=("npm")
command -v git >/dev/null 2>&1 || manquants+=("git")

if [ ${#manquants[@]} -gt 0 ]; then
  rouge "  Prérequis manquants : ${manquants[*]}"
  rouge "  Avec nvm : nvm install $REQUIRED_NODE_MAJOR && nvm use $REQUIRED_NODE_MAJOR"
  exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
  rouge "  Node $REQUIRED_NODE_MAJOR ou plus récent est requis (détecté : v$(node -p 'process.versions.node'))."
  rouge "  La base de données emploie « node:sqlite », apparu en Node 22."
  rouge "  Avec nvm : nvm install $REQUIRED_NODE_MAJOR && nvm use $REQUIRED_NODE_MAJOR"
  exit 1
fi

# Claude Code n'est pas un prérequis dur — le SDK embarque son propre binaire —
# mais sans authentification aucun agent ne tourne. On le signale sans bloquer.
if ! command -v claude >/dev/null 2>&1 && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  printf '\033[33m%s\033[0m\n' "  ⚠ Ni le CLI « claude » ni ANTHROPIC_API_KEY détectés."
  printf '\033[33m%s\033[0m\n' "    Maestro s'installera, mais aucun agent ne pourra s'exécuter avant"
  printf '\033[33m%s\033[0m\n' "    d'avoir authentifié Claude Code (« claude » puis /login) ou défini une clé."
  echo
fi

# -- Récupération des sources ------------------------------------------------
#
# Deux situations : on est déjà dans le dépôt (le cas normal quand on a cloné),
# ou le script a été récupéré seul par curl et il faut cloner.
if [ -f "package.json" ] && grep -q '"name": "maestro"' package.json 2>/dev/null; then
  TARGET="$(pwd)"
  bleu "  Dépôt détecté dans $TARGET"
elif [ -n "$REPO_URL" ]; then
  if [ -d "$TARGET/.git" ]; then
    bleu "  Mise à jour de $TARGET"
    git -C "$TARGET" pull --ff-only
  else
    bleu "  Clonage dans $TARGET"
    git clone "$REPO_URL" "$TARGET"
  fi
  cd "$TARGET"
else
  rouge "  Ce script n'a pas été lancé depuis le dépôt, et MAESTRO_REPO n'est pas défini."
  rouge "  Cloner puis relancer :"
  rouge "    git clone <url> ~/maestro && cd ~/maestro && bash scripts/install.sh"
  rouge "  ou :  MAESTRO_REPO=<url> bash scripts/install.sh"
  exit 1
fi

# -- Dépendances et construction ---------------------------------------------
echo
bleu "  Installation des dépendances…"
# `npm ci` plutôt que `npm install` : il respecte le verrou à la lettre, donc
# deux installations à deux jours d'écart donnent le même arbre.
npm ci --no-audit --no-fund

echo
bleu "  Construction de l'interface…"
npm run build

# -- Configuration -----------------------------------------------------------
echo
if [ -t 0 ] && [ -t 1 ]; then
  # Interactif : l'assistant peut poser ses questions.
  bleu "  Configuration"
  node scripts/setup.mjs
else
  # Sous un pipe (`curl | bash`), stdin n'est pas un terminal : poser une
  # question la lirait dans le flux du script lui-même. On s'arrête là et on
  # dit quoi faire.
  vert "  ✓ Installation terminée."
  echo
  echo "  Configurer, puis démarrer :"
  echo "    cd $TARGET"
  echo "    npm run setup"
  echo "    npm start"
  echo
  exit 0
fi

echo
vert "  ✓ Maestro est prêt."
echo
echo "    npm start        démarre le serveur"
echo "    npm run qa       contrôle qualité complet"
echo
