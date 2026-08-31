# 🎛 Maestro

**Poste de commandement self-hosted pour orchestrer des agents Claude Code.**

Maestro transforme une machine (poste de travail, VPS) en centre de contrôle d'agents IA :
tu crées des agents spécialisés, tu leur confies des tâches — à la demande, par kanban,
par cron ou depuis Telegram — et tu supervises tout en temps réel : flux de messages,
approbations d'outils, tokens et coûts.

> Prérequis d'authentification : Maestro pilote **Claude Code** via le
> [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk). Il réutilise
> l'authentification existante de la machine (abonnement Claude connecté via `claude`,
> ou variable `ANTHROPIC_API_KEY`).

---

## Fonctionnalités

### Agents

- Agents illimités : création, clonage, archivage, gabarits (développeur, relecteur, veilleur…)
- Par agent : modèle (`sonnet` / `opus` / `haiku` ou id complet), CLAUDE.md dédié,
  **mémoire persistante** (`MEMORY.md`), workspace isolé, mode de permission,
  politique d'approbation, garde-fous (tours max, délai max, budget de tokens)
- Deux moteurs d'exécution :
  - **SDK** (par défaut) : session Claude Agent SDK headless — streaming fin,
    permissions interceptées, outils MCP, reprise de session ;
  - **tmux** : session `claude` interactive attachable (`tmux attach -t maestro-…`)
    pour reprendre la main dans un vrai terminal.

### Mission Control

- Graphe force-directed des agents (drag & drop, positions épinglées persistées)
- Flux de messages animés en temps réel entre le hub et les agents
- Inspecteur par agent : configuration, runs récents, dernier événement
- Journal d'événements en direct, débit (évt/s), runs actifs, uptime, tokens et coût du jour

### Radar de sessions

- Détection automatique des sessions d'agents de code actives sur la machine —
  **Claude Code**, et **Codex, Gemini, Aider, Cursor, OpenCode, Goose** dès que
  leur binaire est présent — qu'elles soient pilotées par Maestro ou lancées à la
  main dans un terminal
- Deux sources délibérément asymétriques : les **transcripts** de session font
  foi pour Claude Code (un serveur MCP ou un sidecar n'en écrit pas, là où un
  `ps` sur « claude » les compterait comme des sessions), les **processus**
  couvrent les autres outils et enrichissent en pid, charge CPU et ancienneté
- Chaque session détectée expose projet, branche git, version, entrypoint et
  dernière activité, et indique si elle est **rattachée à un agent Maestro** ou
  sauvage
- Visualisation en radar polaire : angle stable par session, distance selon la
  fraîcheur (active au centre, inactive en bordure), balayage animé
- 🔒 Seules des **métadonnées** sont lues dans un transcript : chemin, identifiant
  de session, version, branche, horodatage. Jamais le contenu des messages

### Runs

- Lancement manuel, transcript en direct (texte, réflexion, outils, résultats)
- Reprise de session (`resume`), suivi tokens/cache/coût par run
- Annulation en cascade : annuler un run annule les runs qu'il a délégués
- File d'attente globale (concurrence maîtrisée) et **un run à la fois par agent**,
  délégations comprises — deux sessions ne partagent jamais un workspace. Seule une
  délégation bloquante (`wait=true`) dépasse le plafond global, le temps que le
  parent l'attende ; une délégation asynchrone y est soumise, ce qui borne le fan-out

### Approbations (human-in-the-loop)

- Chaque outil sensible passe par le broker : politique `auto` / `guarded`
  (lecture libre, écriture approuvée) / `ask` (tout approuvé)
- Résolution depuis le web **ou Telegram**, avec expiration automatique
- Historique complet (qui a autorisé quoi, quand, par quel canal)

### Kanban

- Backlog → En cours → Revue → Terminé
- **Les agents avancent leurs cartes eux-mêmes** via l'outil MCP `maestro_task_update`
  (et commentent leur progression) ; l'humain arbitre
- « Confier à l'agent » : la carte devient le contexte du run

### Skills

- Registre markdown à quatre portées : intégrés (livrés), **Claude Code**
  (`~/.claude/skills`, lues en place et jamais recopiées), globaux, par agent
- Éditeur intégré ; matérialisation automatique au format natif Claude Code
  (`.claude/skills/<slug>/SKILL.md`) dans le workspace de chaque agent
- « Utiliser » : lance un run agent + skill + demande
- **Les agents écrivent leurs propres skills** via l'outil MCP `skill_save` :
  une méthode non triviale trouvée pendant un run est consignée et disponible au
  suivant. La mémoire retenait un fait, rien ne retenait une démarche.
  🔒 Portée agent uniquement — écrire une skill globale changerait le
  comportement de tous les autres agents à leur insu ; la promotion reste un
  geste humain
- **Format ouvert dans les deux sens** : le `SKILL.md` de Maestro (frontmatter
  `name` / `description` puis markdown) est celui de Claude Code et des hubs
  communautaires. L'import depuis un dépôt distant existait ; l'export d'une
  skill, pour la republier ailleurs, s'ajoute — y compris pour une skill écrite
  par un agent

### MCP — serveurs déclarés et outils maison

Deux façons de donner des outils à un agent, dans un même registre :

- **Déclarer un serveur existant** : `stdio` (processus local, commande +
  arguments + variables d'environnement) ou `http` / `sse` (URL + en-têtes).
  Maestro le transmet au SDK, il n'y touche pas.
- **Créer ses outils depuis l'interface** — le « MCP simplifié ». On décrit un
  outil (nom, description, paramètres typés, valeurs autorisées) et son action ;
  Maestro l'expose comme un vrai serveur MCP in-process, sans dépôt à écrire ni
  processus à faire tourner. Deux actions :
  - **appel HTTP** : méthode, URL gabarit, en-têtes, corps, chemin à extraire de
    la réponse JSON ;
  - **réponse gabaritée** : un texte avec interpolation des paramètres, utile
    pour une procédure ou une consigne.
- **Essai avant ouverture** : chaque outil maison s'exécute depuis l'interface,
  avec ses paramètres, avant d'être confié à un agent
- Activation **par agent** ; interrupteur global par serveur ; les outils
  s'appellent `mcp__<serveur>__<outil>` et passent donc par la politique
  d'approbation de l'agent, comme n'importe quel outil

🔒 L'origine d'une URL d'outil (schéma, hôte, port) doit être littérale : seuls
le chemin, la requête et le corps acceptent des `{{paramètres}}`. Sans cette
règle, un agent choisirait sa cible et pourrait atteindre un service interne.
Il n'existe volontairement **pas d'action « commande shell »** : ce serait donner
l'exécution de code arbitraire à un modèle via un formulaire, alors que Bash
existe déjà sous contrôle d'approbation.

🔒 Les valeurs d'environnement et d'en-têtes sont stockées mais **jamais
renvoyées au client** : l'interface n'en voit qu'un masque, et un aller-retour
d'édition ne peut ni les afficher ni les effacer.

### Passerelle MCP — Maestro vu par Codex, OpenCode & co.

Les outils de Maestro ne servent pas qu'aux agents Maestro : la passerelle les
expose comme un **serveur MCP standard**, que n'importe quel client MCP peut
déclarer — Codex CLI, OpenCode, Gemini CLI, Goose, Cursor, Windsurf, Zed.

Deux transports pour le même périmètre :

| Transport           | Point d'entrée                        | Pour qui                             |
| ------------------- | ------------------------------------- | ------------------------------------ |
| **Streamable HTTP** | `POST /mcp`, en-tête `Bearer`         | clients distants, autre machine      |
| **stdio**           | `packages/server/bin/maestro-mcp.mjs` | clients locaux, config par processus |

Le pont stdio est un relais : il ne duplique aucune logique, il traduit stdio en
HTTP. Il se configure par variables d'environnement — `MAESTRO_URL`
(défaut `http://127.0.0.1:4520`), `MAESTRO_TOKEN` (à défaut il lit
`<dataDir>/token`), `MAESTRO_AGENT` (optionnel).

```jsonc
// Exemple de déclaration côté client (Codex, OpenCode, Goose, Cursor…)
{
  "mcpServers": {
    "maestro": {
      "command": "node",
      "args": ["/chemin/vers/maestro/packages/server/bin/maestro-mcp.mjs"],
      "env": { "MAESTRO_AGENT": "Comptabilité" },
    },
  },
}
```

**Ce que la passerelle expose** : `rag_collections`, `rag_search`, et les outils
maison du registre, aplatis en `<serveur>__<outil>` (donc
`mcp__maestro__crm__lister` vu du modèle).

**Ce qu'elle n'expose pas, et pourquoi** :

- les outils de contrôle (`maestro_task_*`, `send_to_agent`, `memory_save`)
  exigent un contexte de run — identité, comptabilisation, annulation. Les ouvrir
  sans ça ferait agir un agent tiers dans l'angle mort de Mission Control ;
- les serveurs MCP _externes_ du registre ne sont pas relayés : le client tiers
  sait les déclarer lui-même, un proxy n'ajouterait qu'un saut réseau ;
- un outil maison marqué **« approbation requise »** est annoncé mais **refusé** :
  un client externe ne passe par aucun broker, l'exécuter contournerait en
  silence une approbation que l'interface promet.

**Périmètre.** Sans en-tête, le client voit tout ce qui est activé — c'est le
périmètre du jeton, qui ouvre déjà l'API complète. Avec
`X-Maestro-Agent: <nom ou id>`, il se réduit à celui de cet agent : exactement
les collections et outils confiés à cet agent Maestro, rien d'autre. Le nom se
compare sans casse ni accents, et la passerelle rattrape le recodage latin-1 que
la spécification HTTP impose aux en-têtes — « Développeur » fonctionne, même
transmis en UTF-8 brut.

### RAG — collections documentaires

- **Collections** avec taille de découpe et recouvrement réglables
- **Quatre sources d'alimentation** : texte collé, fichier, dossier (parcours
  récursif, binaires et répertoires techniques écartés), page web (texte extrait),
  workspace d'un agent
- **Recherche hybride** : BM25 via FTS5 pour les termes exacts, embeddings pour
  les reformulations, fusionnés par rang réciproque. La partie sémantique est
  facultative : sans clé d'API, la recherche reste lexicale **et le dit**
- Réingérer une même origine **remplace** le document au lieu de le dupliquer
- **Essai de recherche** depuis l'interface, qui montre exactement ce que verra
  un agent
- Exposé aux agents par le serveur MCP `rag` : `rag_collections` et
  `rag_search`. Un agent ne voit que les collections cochées dans sa
  configuration

Sans clé d'API, tout fonctionne hors ligne. Pour activer la partie sémantique,
définir `VOYAGE_API_KEY` ou `OPENAI_API_KEY` dans l'environnement du serveur :
🔒 la clé n'est jamais stockée par Maestro, ni exposée à l'interface.

### Connecteurs — skills, agents et plugins

- Trois cibles d'import depuis les mêmes connecteurs :
  - **skill** → registre de skills (portée globale ou par agent) ;
  - **agent** → un « subagent » du catalogue devient un agent Maestro : le corps
    markdown fournit le prompt système, le frontmatter préremplit modèle, couleur
    et outils autorisés, et la politique d'approbation se déduit de la présence de
    `Write`/`Edit` dans ses outils ;
  - **plugin** → dépôt cloné sous `<dataDir>/plugins`, validé par
    `claude plugin validate`, puis chargé par session (`--plugin-dir` en tmux,
    `plugins: [{type:'local'}]` en SDK). Attachement **par agent**, dans
    _Configuration → Plugins chargés_ ; mise à jour et désinstallation dans
    _Paramètres → Plugins_ (désinstaller détache le plugin des agents concernés)
- L'inventaire d'un plugin (skills, agents, commandes, hooks, serveurs MCP) est
  mesuré sur le disque après clonage, pas lu dans le manifeste — beaucoup de
  plugins n'y déclarent rien
- Import depuis des catalogues distants, avec deux connecteurs livrés :
  **Claude Skills Hub** ([claudeskills.info](https://claudeskills.info/), ~15 000
  entrées, recherche par mot-clé, catégorie, type, étoiles) et **GitHub** (import
  direct d'un `SKILL.md` par URL ou `owner/repo/chemin`)
- Le catalogue ne publiant aucune commande d'installation, Maestro résout lui-même
  le contenu : conversion d'un lien GitHub en fichier brut, ou recherche du
  `SKILL.md` aux emplacements conventionnels quand la source ne désigne qu'un dépôt
- Provenance conservée dans le frontmatter (`source:`) : une skill tierce reste
  traçable, et l'UI affiche le lien vers l'original
- 🔒 Trois garde-fous : le serveur ne contacte que des hôtes explicitement
  autorisés (une référence utilisateur ne devient pas une requête sortante
  arbitraire), les redirections hors allowlist sont refusées, et le contenu
  installé est celui relu à la source — jamais un corps transmis par le client
- 🔒 **Prévisualisation obligatoire avant import.** Une skill ou un agent importé
  est une consigne injectée dans une session qui a accès à tes outils ; un plugin
  apporte en plus du code exécutable (hooks) et parfois des serveurs MCP, donc des
  connexions sortantes. Relire avant d'installer est un contrôle de sécurité, pas
  une formalité — le manifeste et l'inventaire sont affichés pour cela
- 🔒 Le clonage est restreint aux URL GitHub, et la désinstallation ne supprime
  que sous le répertoire géré par Maestro

### Routines (cron)

- Planification agent + skill + prompt (expressions cron, presets)
- Run-now, historique, délai max, notification de fin

### Pipelines (chaînes d'agents)

- Étapes séquentielles multi-agents ; variables de gabarit `{{input}}`, `{{prev}}`,
  `{{steps.<nom>}}`
- Suivi d'exécution étape par étape, sortie de chaque étape consultable

### Entraînement — jeux de données à partir du travail des agents

Chaque run laisse derrière lui une suite d'événements : consigne, texte, appels
d'outils, observations, réponse. C'est exactement la forme d'une trajectoire
d'entraînement. Maestro sait donc les relire, en fabriquer en série, et les
exporter au format d'un outil de fine-tuning.

**Lots de génération**

- Un lot décrit des gabarits de prompt (`{{variable}}` substitué), des jeux de
  valeurs, un nombre d'échantillons et une **distribution d'outils** pondérée —
  de quoi déséquilibrer volontairement un corpus (70 % de lectures, 30 %
  d'écritures)
- Le tirage est **reproductible** : la graine dérive de l'identifiant du lot et
  de l'index de l'échantillon, donc relancer un lot ne change pas son plan
- **Checkpointing par échantillon** : l'état est écrit à chaque transition, pas
  à la fin. Un arrêt brutal au millième échantillon ne coûte que celui-là, et le
  lot reprend seul au démarrage suivant
- Pause, reprise, annulation, tentatives multiples par échantillon
- ⚠️ Le parallélisme vient du **pool d'agents**, pas d'un nombre de workers : un
  agent n'exécute jamais deux runs à la fois, son workspace est unique. Un lot
  confié à quatre agents produit quatre trajectoires de front, pas davantage

**Notation (récompense)**

- Un **agent juge** facultatif note chaque trajectoire entre 0 et 1 ; la note
  peut être corrigée à la main dans l'interface
- Sans note, un export destiné au renforcement n'a aucun signal : les
  trajectoires non notées sont écartées, en le disant

**Export**

- Formats : **ShareGPT** (Axolotl, LLaMA-Factory, Unsloth), **OpenAI**
  (`messages` + `tool_calls` natifs), **Atropos** (rollouts scorés pour
  l'apprentissage par renforcement), **brut** (la forme canonique, sans perte)
- **Onze dialectes d'appels d'outils** — Hermes/ChatML, OpenAI, Mistral, Llama 3
  (JSON et balise python), pythonic, DeepSeek, Command R, Granite, Functionary,
  JSON par ligne. Exporter dans la mauvaise convention apprend au modèle une
  syntaxe qu'il n'émettra jamais ; chaque dialecte est vérifié par un
  aller-retour rendu → lecture
- **Compression sous budget de tokens**, par ordre croissant de dégât : la
  réflexion d'abord, puis les retours d'outils les plus longs, et seulement en
  dernier recours des tours entiers — la première consigne et la réponse finale
  ne sont jamais sacrifiées, et appels et observations restent appariés
- Sortie en **JSONL**, une trajectoire par ligne. L'aperçu dit combien sont
  retenues, lesquelles sont écartées et pourquoi, avant d'écrire un fichier
- La source peut être un lot **ou les runs récents de l'instance** : le travail
  réel fait souvent les meilleures trajectoires

> 🔒 **Un jeu de données exporté contient les prompts et les retours d'outils
> intégraux.** S'ils portent sur des dossiers réels, ce sont des données
> personnelles en clair — noms, SIRET, montants nominatifs, extraits de liasse.
> Le fichier quitte Maestro et part généralement ailleurs (dépôt de fine-tuning,
> service d'entraînement tiers) : le relire avant de le transmettre, et
> pseudonymiser si le corpus doit sortir de l'entreprise.

> ⚠️ Par défaut un retour d'outil est raccourci à 1 500 caractères — le
> transcript est fait pour être lu. Pour de l'entraînement, ce raccourci devient
> une erreur d'étiquetage. Le réglage **« Capture intégrale des retours
> d'outils »** (Paramètres) porte la limite à 60 000 caractères, au prix d'une
> base plus volumineuse, et ne s'applique qu'aux runs suivants.

### Délégation inter-agents

- Outil MCP `maestro_send_to_agent` : un agent confie une sous-tâche à un autre
  (asynchrone, ou bloquant avec `wait=true`), profondeur limitée (anti-boucle)

### Messagerie — Telegram, Discord, Slack

Les trois canaux répondent aux mêmes commandes : `/agents`, `/status`,
`/approvals`, `/run <agent> <prompt>`. La logique est partagée
(`chat-commands.ts`) et seul le rendu diffère — HTML pour Telegram, markdown pour
Discord, mrkdwn pour Slack ; une commande corrigée l'est sur les trois.

- **Telegram** — bot bidirectionnel, notifications de fin de run et
  **approbations résolues par boutons**, directement dans la conversation
- **Discord** — Gateway WebSocket, sans dépendance. ⚠️ L'intent privilégié
  « Message Content » doit être activé dans le portail développeur, faute de quoi
  les messages arrivent sans texte ; Maestro le détecte et le dit dans ses
  journaux plutôt que de rester muet
- **Slack** — Socket Mode, et non l'API Events : celle-ci exigerait une URL
  publique que Slack appelle. Maestro étant fait pour tourner derrière un
  pare-feu, c'est lui qui se connecte. Deux jetons distincts : `xapp-` ouvre la
  socket, `xoxb-` poste
- 🔒 **Liste blanche stricte et obligatoire** sur les trois canaux : un jeton sans
  liste laisse la passerelle inactive, et le démarrage le signale. Un bot qui
  répond partout exécute des agents pour n'importe qui
- Les approbations ne se résolvent par boutons que sur Telegram : Discord et
  Slack exigeraient un point d'entrée HTTP public pour recevoir les
  interactions. Sur ces deux canaux, la demande est notifiée et renvoie vers
  l'interface

### Banc de non-régression

Modifier le CLAUDE.md d'un agent ou son modèle était un acte de foi. Rejoue le
même jeu de prompts avant et après, puis compare les deux lots : l'écart se lit
cas par cas — score, mais aussi coût, parce qu'un agent qui gagne deux centièmes
en doublant sa facture n'est pas une amélioration.

- Appariement **sur le prompt**, jamais sur l'index : deux lots sans prompt
  commun sont refusés plutôt que comparés à tort
- Un écart inférieur à 0,05 est déclaré stable — un juge ne rend pas deux fois
  la même note, et voir des progrès dans le bruit ferait décider à tort
- Un échantillon non noté est « incomparable », pas « stable » : le ranger dans
  les stables masquerait la régression qu'on cherche

### Exploitation

- **Rétention** des transcripts et du journal, en jours. Illimitée par défaut :
  l'activer détruit des données, c'est une décision qu'on prend sur un chiffre —
  la taille réelle de la base est affichée à côté du réglage
- **Sauvegarde à chaud** (`VACUUM INTO`), depuis l'interface ou en ligne de
  commande (`npm run backup`), rotation sur sept. 🔒 Une sauvegarde contient tout,
  clés MCP comprises : le répertoire est en 0700
- **Métriques Prometheus** sur `/api/metrics/prometheus` — file d'attente,
  approbations en attente, coût du jour, taille de la base
- **Priorité de file** : un lot d'entraînement ne peut jamais prendre la
  dernière place du plafond de concurrence. La priorité se déduit de l'origine,
  parce que c'est elle qui dit si quelqu'un attend devant son écran

### Confinement d'un agent

Optionnel et par agent : `sandbox: null` par défaut, et ne rien régler laisse
Maestro se comporter exactement comme avant. C'est une décision prise pour un
agent dont on n'est pas sûr, pas un péage que tous les autres paient.

Le bac à sable est celui de Claude Code — isolation du système de fichiers par
chemin, egress réseau filtré, seccomp — appliqué aux commandes que l'agent
lance. Plus fin qu'un conteneur : la session continue de parler à l'API pendant
que les commandes, elles, restent enfermées.

> ⚠️ **Prérequis système : `bubblewrap` et `socat`.** Sans eux, le bac à sable ne
> peut pas démarrer :
>
> ```
> sudo apt install bubblewrap socat
> ```
>
> Deux comportements, selon le réglage **« Exiger le confinement »** :
>
> - **décoché** (défaut) — l'agent tourne **sans confinement**, avec un
>   avertissement au journal. Pratique, mais il faut le savoir : le réglage est
>   actif dans l'interface alors que rien ne confine ;
> - **coché** — le run **échoue** en nommant les dépendances manquantes. C'est le
>   bon choix pour un agent précisément jugé risqué, où « dégradé en silence »
>   est le pire des cas.

🔒 Le jeton d'accès et la base de Maestro sont toujours illisibles depuis un
agent confiné, quelle que soit la configuration : les lire suffirait à se faire
lancer un run non confiné, et le confinement s'annulerait lui-même en une
commande.

Pour une frontière plus dure autour de l'instance entière, le `Dockerfile` et le
`docker-compose.yml` fournis sont durcis (racine en lecture seule, capacités
retirées, plafonds de processus, de mémoire et de CPU). Ils restent un chemin
optionnel : `npm start` fonctionne sans.

### Accès et traçabilité

- **Jetons nommés** : un par personne ou par script, révocables
  individuellement et avec effet immédiat. Une approbation dit désormais _qui_ a
  tranché, et plus seulement par quel canal
- 🔒 Seule l'empreinte SHA-256 est stockée — un vol de base ne donne aucun accès,
  et c'est pourquoi la valeur n'est montrée qu'une fois
- 🔒 **Secrets des serveurs MCP chiffrés au repos** (AES-256-GCM), clé dans un
  fichier séparé : la clé et la base ne voyagent pas ensemble
- Le jeton principal reste hors de portée de la révocation : c'est lui qui
  permet de reprendre la main

### Analytique & garde-fous

- Tokens et coûts par jour / agent / modèle, statistiques par agent
- Garde-fous par agent : `maxTurns`, `timeoutSec`, `tokenBudget`
- Aucun proxy : les appels partent directement via Claude Code, aucun coût intermédiaire

---

## Démarrage rapide

```bash
# Prérequis : Node.js >= 22 (node:sqlite), Claude Code authentifié sur la machine
git clone <ce dépôt> && cd maestro
npm install

# Développement (serveur :4520 + front Vite :4521)
npm run dev

# Production : build du front puis serveur unique
npm run build
npm start
```

Au premier démarrage, le serveur affiche le **jeton d'accès** (persisté dans
`~/.maestro/token`). Ouvre `http://localhost:4520` (ou `:4521` en dev) et colle-le.

## Configuration

Variables d'environnement (voir `.env.example`) :

| Variable                  | Défaut           | Rôle                                                   |
| ------------------------- | ---------------- | ------------------------------------------------------ |
| `MAESTRO_PORT`            | `4520`           | Port HTTP (API + WebSocket + front)                    |
| `MAESTRO_DATA_DIR`        | `~/.maestro`     | Base SQLite, workspaces, skills, jeton                 |
| `MAESTRO_TOKEN`           | généré           | Jeton d'accès de l'interface                           |
| `MAESTRO_ALLOWED_ORIGINS` | origines locales | Origines autorisées en CORS, séparées par des virgules |
| `TELEGRAM_BOT_TOKEN`      | —                | Jeton du bot (@BotFather) — active Telegram            |
| `TELEGRAM_CHAT_IDS`       | —                | Chats autorisés, séparés par des virgules              |
| `VOYAGE_API_KEY`          | —                | Embeddings RAG (Voyage) — active le sémantique         |
| `OPENAI_API_KEY`          | —                | Embeddings RAG (OpenAI), si Voyage est absent          |

Paramètres modifiables dans l'UI (Paramètres) : concurrence max, délai d'expiration
des approbations, profondeur de délégation, notifications Telegram globales.

## Équipe claude-index

Maestro sait exécuter une session **sous une définition d'agent Claude Code
native** (`~/.claude/agents/<nom>.md`) plutôt que sous un prompt recopié : c'est
le champ `cliAgent` d'un agent (`claude --agent <nom>` en tmux, `options.agent`
en SDK). Persona, outils autorisés, hooks et skills d'origine s'appliquent —
un `git pull` dans le dépôt de configuration met à jour le comportement sans
reprovisionner quoi que ce soit.

Pour provisionner l'équipe et les chaînes de [claude-index](https://gitlab.cneidf.net/devops/claude-index) :

```bash
node scripts/provision-claude-index.mjs --dry-run   # simulation
node scripts/provision-claude-index.mjs            # écriture
```

Le script lit les définitions d'agents, en déduit modèle, garde-fous et politique
d'approbation (un agent qui peut écrire passe en `guarded`), puis crée 12 agents
et 4 pipelines. Il est idempotent : l'appariement se fait sur `cliAgent`, donc
relancer met à jour sans dupliquer, et un agent maison homonyme n'est jamais
écrasé. Le nom que tu donnes à un agent dans l'UI est respecté.

| Pipeline                    | Chaîne                                                 |
| --------------------------- | ------------------------------------------------------ |
| Audit qualité complet       | analyst → code-reviewer → security-auditor             |
| Refactorisation sécurisée   | test-author → refactorer → qa-fixer                    |
| Prêt à merger               | qa-fixer → code-reviewer → mr-author                   |
| Fonctionnalité back Symfony | analyst → symfony-expert → test-author → code-reviewer |

### Subagents et topologie

La hiérarchie n'est pas plate : `lead` délègue à neuf experts, qui sont donc ses
**subagents**, tandis que `mr-author` et `Explore` s'invoquent directement. Le
script déduit cette structure de la ligne `tools: … Agent(…)` de `lead.md` et la
matérialise via le champ `parentAgentId` d'un agent. Mission Control la rend
telle quelle : liens hub → premier niveau plus longs, liens parent → subagent plus
courts et plus discrets, nœuds décroissants selon le niveau, et impulsions de
messages qui suivent l'arête réelle (Maestro → lead → expert, et le résultat en
retour). Modifiable dans _Agents → &lt;agent&gt; → Configuration → Agent parent_.

```
Maestro
├── 🧭 Explorateur
├── 🎯 Lead
│    ├── 🐘 Symfony      ├── 🗺️ Analyste     ├── 🩹 QA
│    ├── 🎨 Front        ├── 🔍 Revue de code ├── ♻️ Refactorisation
│    ├── 🛠️ DevOps       ├── 🛡️ Sécurité      └── 🧪 Tests
└── 📝 Merge request
```

### Skills claude-index

Les 26 skills du dépôt apparaissent dans le registre sous la portée **Claude
Code**, en lecture seule. Elles ne sont pas recopiées : sélectionner une skill
native injecte une consigne de chargement (`Applique la skill \`x\``) et c'est le
CLI qui la charge, dans sa version courante — le contexte n'est pas payé deux
fois et rien ne peut diverger de claude-index. Un run SDK dont la skill est
native lit `~/.claude` en plus du projet, pour pouvoir la trouver.

Deux points à connaître :

- **Une session tmux ne se termine pas d'elle-même** (c'est un REPL interactif).
  Un run tmux finit donc à la sortie de l'utilisateur, à l'annulation, ou au
  délai maximal de l'agent — 2 h pour les agents provisionnés. Termine-le tout de
  suite depuis _Paramètres → Sessions tmux_.
- **Les pipelines forcent le moteur SDK**, quel que soit le moteur de l'agent :
  un enchaînement a besoin de runs qui terminent. Les approbations repassent
  alors par Maestro (web/Telegram) au lieu du terminal.

Les workspaces créés par Maestro sont pré-approuvés auprès du CLI (sinon son
dialogue « trust this folder » bloquerait une session non surveillée). Un dépôt
qui t'appartient ne l'est jamais automatiquement : cette décision te revient.

## Design system

L'interface suit un design system unique, documenté dans
[`DESIGN-AUDIT.md`](DESIGN-AUDIT.md) — un audit selon les dix principes de Dieter
Rams, noté 20/30, verdict « affiner ». La passe qui a suivi a consolidé :

- **une seule échelle d'espacement** (base 4 : `--space-1` à `--space-8`) là où
  quinze valeurs ad hoc coexistaient, et **six graduations typographiques**
  (`--text-xs` à `--text-xl`) au lieu de quatorze tailles dont des demi-pixels ;
- **le focus clavier**, rétabli : `outline: none` était appliqué aux champs sans
  remplacement, et aucun `:focus-visible` n'existait — la navigation au clavier
  était donc invisible ;
- **le mouvement, désormais conditionnel** : `prefers-reduced-motion` coupe les
  transitions CSS, et les canvas (graphe, radar) interrogent la même préférence
  en JavaScript — un tableau de bord reste ouvert des heures ;
- **les erreurs annoncées** : les zones d'erreur portent `role="alert"` ;
- **les libellés associés** : `Field` génère un identifiant et le rattache à son
  contrôle, ce qu'un `<label>` sans `htmlFor` ne faisait pas.

## Architecture

```
packages/
├── shared/   Types du domaine + protocole temps réel (source de vérité)
├── server/   Node 24 · Fastify · SQLite natif (node:sqlite) · Claude Agent SDK
│   ├── runs.ts          Moteur : sessions SDK/tmux, file, garde-fous, reprise
│   ├── permissions.ts   Broker d'approbations (web/Telegram/politique/expiration)
│   ├── mcp-control.ts   Serveur MCP « maestro » exposé aux agents
│   ├── agents.ts        Workspaces, CLAUDE.md, mémoire, gabarits
│   ├── skills.ts        Registre markdown 3 portées + sync natif Claude Code
│   ├── kanban.ts        Cartes + transitions automatiques liées aux runs
│   ├── scheduler.ts     Routines cron (croner)
│   ├── pipelines.ts     Chaînes d'agents séquentielles
│   ├── training.ts      Lots de génération : workers, checkpoint, notation
│   ├── training-trajectory.ts  Run → trajectoire canonique, compression
│   ├── training-parsers.ts     11 dialectes d'appels d'outils (rendu + lecture)
│   ├── training-export.ts      ShareGPT / OpenAI / Atropos / brut, en JSONL
│   ├── sandbox.ts       Confinement par agent (bac à sable Claude Code)
│   ├── mcp-presets.ts   Catalogue de serveurs MCP prêts à déclarer
│   ├── chat-commands.ts Commandes de messagerie, communes aux trois canaux
│   ├── telegram.ts      Bot long-polling (zéro dépendance)
│   ├── discord.ts       Gateway WebSocket v10 (zéro dépendance)
│   ├── slack.ts         Socket Mode (zéro dépendance)
│   └── tmux.ts          Sessions attachables
└── web/      React 19 · Vite · zustand · d3-force — thème « mission control »
```

**Principe temps réel** : toutes les mutations passent par l'API REST ; le WebSocket
(`/ws`) est un flux descendant d'événements (`run.event`, `approval.requested`,
`task.updated`, `metrics.tick`…) qui tient l'interface à jour.

**Outils MCP exposés à chaque agent** (`mcp__maestro__*`) :
`task_create`, `task_update`, `send_to_agent`, `memory_save`, `skill_save`, `report`.

## Sécurité

- Jeton d'accès obligatoire sur l'API, la passerelle MCP et le WebSocket (généré
  si absent, `0600`). Le jeton en paramètre de requête n'est accepté **que** sur
  `/ws`, où l'API navigateur interdit les en-têtes ; ailleurs il fuirait dans les
  journaux du serveur, ceux du reverse proxy et l'historique du navigateur
- CORS restreint à une liste d'origines (`MAESTRO_ALLOWED_ORIGINS`) : l'interface
  est servie par le même serveur, aucun appel d'origine croisée n'est nécessaire
- Telegram : whitelist stricte de `chat_id` ; aucun secret en base
- Politique d'approbation par agent ; `bypassPermissions` réservé aux agents de confiance
- Expose le port derrière un reverse proxy TLS (Caddy, Nginx) pour un accès distant ;
  l'interface est responsive (pilotage mobile)

## Licence

Projet personnel / interne. Aucun affiliation avec Anthropic.
