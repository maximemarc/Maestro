# 🎛 Maestro

**Poste de commandement self-hosted pour orchestrer des agents Claude Code.**

Maestro transforme une machine (poste de travail, VPS) en centre de contrôle d'agents IA :
tu crées des agents spécialisés, tu leur confies des tâches — à la demande, par kanban,
par cron ou depuis Telegram — et tu supervises tout en temps réel : flux de messages,
approbations d'outils, tokens et coûts.

> Prérequis d'authentification : par défaut, Maestro pilote **Claude Code** via le
> [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) et réutilise
> l'authentification existante de la machine (abonnement Claude connecté via `claude`,
> ou variable `ANTHROPIC_API_KEY`). Il sait aussi répartir ses runs sur **plusieurs
> comptes** et sur **d'autres moteurs** — Codex, OpenCode, une API HTTP — avec repli
> automatique : voir [Fournisseurs, comptes et repli](#fournisseurs-comptes-et-repli).

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

### Fournisseurs, comptes et repli

Un run n'est plus « une session Claude Code » mais **une tentative sur un compte
d'un fournisseur**. Cette indirection est ce qui permet de tenir quand un quota
tombe, et d'exécuter ailleurs que chez Anthropic.

- **Comptes** — un compte est une identité d'exécution :
  - _profil d'abonnement_ : un `CLAUDE_CONFIG_DIR` dédié, avec sa propre session
    et donc **son propre quota**. C'est le mécanisme du multi-comptes Claude ;
  - _clé d'API_ : le **nom** d'une variable d'environnement du serveur. 🔒 La
    valeur n'entre jamais en base et n'est jamais renvoyée à l'interface ;
  - _environnement ambiant_ : le comportement d'avant, sans repli.
- **Fournisseurs** — `claude-sdk` (Claude Code), `codex-cli`, `opencode-cli`, et
  `http-api` (Anthropic Messages ou tout service compatible OpenAI : OpenRouter,
  Ollama, LM Studio).
- **Politiques de résilience** — une liste ordonnée de comptes plus des bornes :
  essais par compte, essais au total, backoff exponentiel avec jitter, attente
  maximale pour un quota, seuil de résumé. Attachable à un agent, à une étape de
  pipeline, ou à l'instance entière.
- **Classification de l'échec** — c'est elle qui décide de la suite, parce que
  la bonne réaction dépend entièrement de la nature de la panne : limite d'usage,
  débit limité, fournisseur saturé, authentification invalide, contexte dépassé,
  incident réseau, garde-fou Maestro. Chaque tentative affiche la classe retenue.
- **Arbitrage face à un quota : avancer plutôt qu'attendre.** On bascule si un
  compte peut prendre le relais ; on n'attend qu'à défaut, et seulement si la
  réouverture est _annoncée_ (en-tête `retry-after`, ou horodatage joint par
  Claude Code). Une heure écrite en prose n'est jamais interprétée : un délai
  deviné vaut moins qu'un échec franc.
- **Anticipation des quotas** — plutôt que d'attendre le refus, Maestro mesure
  la consommation de chaque compte sur une fenêtre glissante (5 h par défaut,
  réglable) et **préfère un compte plus calme** quand celui de tête approche de
  sa limite. La bascule se fait alors _avant_ le mur : aucun run entamé, aucun
  contexte perdu, aucun résumé à reconstruire.
  - _D'où vient la mesure_ : pour un compte Claude, des **transcripts** du
    profil — la seule source qui voie aussi les sessions lancées à la main hors
    de Maestro, qui consomment pourtant le même quota. Pour une API HTTP, des
    tentatives enregistrées. Un moteur CLI tiers ne rapporte pas ses tokens :
    l'interface le dit au lieu d'afficher une jauge à zéro.
  - _D'où vient le plafond_ : de ce que tu déclares, sinon de ce que Maestro
    **apprend** — la consommation constatée au moment où ce compte a heurté sa
    limite. Aucun fournisseur ne publie ce chiffre pour un abonnement ; plutôt
    que d'en inventer un, Maestro retient celui qu'il a vu.
  - _Ce qu'un plafond estimé ne fait jamais_ : refuser un compte. Il ne fait que
    le mettre de côté s'il existe une alternative. Quand tous les comptes sont
    chargés, l'ordre que tu as déclaré reprend la main.
  - Le cache de lecture est exclu du total : facturé une fraction du prix, il
    ferait paraître saturé un compte qui ne fait que relire un gros contexte.
    Mesuré en conditions réelles, l'écart est d'un facteur 35.

- **Reprise ailleurs (handoff)** — au franchissement d'un seuil, tant qu'un
  modèle est joignable, un résumé structuré du travail est rédigé et réinjecté
  en préambule de la tentative suivante. Au blocage, un filet de sécurité
  reconstruit ce résumé **mécaniquement** depuis le journal d'exécution : quand
  tous les comptes sont en quota, plus personne ne peut résumer. Un résumé
  dégradé est signalé comme tel, et versé au `MEMORY.md` de l'agent. Le seuil se
  mesure sur le budget de tokens de l'agent **ou** sur le remplissage de la
  fenêtre du compte — cette seconde jauge est la seule qui existe quand l'agent
  n'a pas de budget déclaré, c'est-à-dire le cas courant.
- **Vue par tentative** — le détail d'un run montre qui a essayé, ce qui a
  échoué, combien de temps on a attendu et où c'est reparti. Cet encart
  n'apparaît qu'à partir de la deuxième tentative.

> ⚠️ **Ce qu'on perd hors du SDK Claude, et qui est affiché, pas masqué.** Les
> moteurs CLI tiers n'exposent aucun équivalent de `canUseTool` : la politique
> d'approbation d'un agent y devient **déclarative**, Maestro ne peut plus
> l'appliquer. Le coût n'est pas rapporté, et le transcript est plus grossier.
> Le fournisseur `http-api`, lui, n'a aucun outil et ne modifie pas le
> workspace — c'est un repli de rédaction, pas un moteur de codage.

> ℹ️ **L'invocation des moteurs CLI n'est pas codée en dur.** Les options non
> interactives de Codex et d'OpenCode changent d'une version à l'autre : une
> ligne de commande figée marcherait chez celui qui l'a écrite et échouerait
> ailleurs. Maestro lit donc `<outil> --help` sur la machine et **n'émet que ce
> que le binaire déclare** — sous-commande, `--json`, `--model` : chaque élément
> n'est ajouté que s'il y figure. Une option disparue est ignorée, une option
> renommée n'est pas inventée, et il n'y a rien à régler. L'invocation déduite
> est affichée sur la page Fournisseurs ; le champ « Arguments » d'un compte ne
> sert qu'à imposer sa propre ligne de commande.
>
> 🔒 Ce qui n'est **jamais** ajouté automatiquement : les options
> d'auto-approbation (`--full-auto` et équivalentes). Elles sont repérées et
> signalées, pas activées — sur un moteur où Maestro n'intercepte déjà plus les
> outils, cumuler le second abandon serait une décision de sécurité prise par
> une heuristique.

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

**Ce que la passerelle expose** : `rag_collections`, `rag_search`, les outils
maison du registre aplatis en `<serveur>__<outil>` (donc
`mcp__maestro__crm__lister` vu du modèle), et — dès qu'un agent est identifié —
les **outils de contrôle** : `task_create`, `task_update`, `send_to_agent`,
`memory_save`.

**Session externe.** Une action de contrôle ouvre un run d'origine `external`,
au nom de l'agent déclaré. Ce run n'exécute rien : le travail se fait chez le
client tiers, dont Maestro n'a ni le transcript, ni les tokens, ni le coût. Il
sert de journal — une ligne dans Mission Control, un parent pour les
délégations, et une prise pour l'annulation. Il se referme après quinze minutes
de silence, parce qu'un client tiers ne prévient pas qu'il s'arrête.

L'annuler **annule en cascade les runs qu'elle a délégués** — c'est le geste
utile. Elle ne coupe pas le client tiers, que Maestro ne pilote pas : un nouvel
appel rouvrira une session. Le message d'annulation le dit.

**Approbations.** Un outil maison marqué « approbation requise » passe par le
même broker que pour un agent Maestro : même file, même historique, même
résolution depuis le web ou Telegram. L'appel MCP attend la décision — plus lent
qu'un refus, et seule façon de tenir la promesse de l'interface sans fermer la
porte. Sans agent identifié, Maestro n'a personne à qui la demander et refuse.

**Ce qu'elle n'expose pas** : les serveurs MCP _externes_ du registre ne sont pas
relayés — le client tiers sait les déclarer lui-même, un proxy n'ajouterait qu'un
saut réseau.

> 🔒 Ce que la passerelle **ne peut pas** offrir, et qu'il ne faut pas laisser
> croire : elle ne voit que les appels qui lui sont adressés. Un client tiers qui
> lit et écrit des fichiers le fait avec ses propres outils, hors de portée de
> Maestro. La gouvernance porte sur le canal Maestro, pas sur la machine.

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

### Battement de cœur — l'orchestrateur qui délibère

Une routine **déclenche** un prompt écrit d'avance. Un battement dresse un état
des lieux — runs actifs, approbations en attente, kanban, échecs récents, comptes
proches de leur limite — le confie à un agent avec ses consignes permanentes
(`HEARTBEAT.md` dans son workspace), et le laisse **décider s'il y a lieu
d'agir**, y compris conclure que non. C'est là toute la différence : un cron agit
toujours.

L'agent agit par ses outils MCP habituels (kanban, délégation, mémoire) : rien de
spécifique n'est ajouté, donc sa politique d'approbation et ses outils autorisés
bornent la délibération comme ils bornent le reste.

Les comptes rendus des battements précédents lui sont **réinjectés**. Sans cette
mémoire, un agent recrée la même carte vingt-quatre fois par jour, faute de
savoir qu'il l'a déjà créée.

> 🔒 **Un orchestrateur qui délibère dépense des tokens sans qu'on lui ait rien
> demandé.** C'est un changement de nature, et les garde-fous en sont la
> condition : désactivé par défaut, agent dédié, plancher de cinq minutes entre
> deux battements, plafond quotidien, budget de tokens de l'agent comme plafond
> par battement, rien pendant qu'un run tourne, et le quota cédé au travail
> demandé par un humain. Un battement qui ne fait rien est un succès, et
> l'historique le distingue d'un battement qui a agi.

### Pipelines (chaînes d'agents)

- Étapes séquentielles multi-agents ; variables de gabarit `{{input}}`, `{{prev}}`,
  `{{steps.<nom>}}`
- Suivi d'exécution étape par étape, sortie de chaque étape consultable
- **Chaîne hétérogène** : chaque étape peut imposer sa propre politique de
  résilience, et donc ses propres fournisseurs — rédiger sur un compte
  d'abonnement, relire sur un autre outil, synthétiser sur une API bon marché,
  sans dupliquer les agents

### Délégation inter-agents

- Outil MCP `maestro_send_to_agent` : un agent confie une sous-tâche à un autre
  (asynchrone, ou bloquant avec `wait=true`), profondeur limitée (anti-boucle)

### Canaux — Telegram, webhooks

Un **canal** relie Maestro à un endroit où des humains regardent. Un message y
circule sous forme **structurée** — titre, faits, corps, actions — et chaque
canal le rend selon ses moyens. C'est ce qui permet d'en ajouter un sans
recopier la logique : décider qu'un run mérite une notification, lister les
agents, lancer un run depuis un message n'a jamais rien eu de telegramien.

- **Telegram** — bidirectionnel : notifications de fin de run, **approbations par
  boutons**, `/run <agent> <prompt>`, `/status`, `/agents`, `/approvals`.
  Whitelist stricte de chats (`TELEGRAM_CHAT_IDS`).
- **Webhook sortant** — Slack, Discord, Mattermost, ou tout point d'entrée
  acceptant du JSON (`MAESTRO_WEBHOOK_URL`). Sans dépendance ni bot à déclarer.

Les deux se complètent plus qu'ils ne se ressemblent, et la différence est
portée par l'interface : un canal **interactif** rend les actions cliquables, un
canal sortant seul ne le peut pas — il les mentionne alors en texte, parce
qu'une approbation qui attend sans qu'on sache où la résoudre est pire qu'une
notification absente.

> 🔒 **Envoyer vers un service tiers, c'est publier.** Le résultat d'un run peut
> contenir du code, des extraits de dossier, des noms de clients. Le webhook
> n'envoie donc par défaut **que l'état** — agent, statut, coût. Y ajouter le
> résultat demande `MAESTRO_WEBHOOK_DETAIL=full` : un choix explicite, pas un
> défaut qu'on subit. L'URL d'un webhook est elle-même un secret — elle reste en
> variable d'environnement et n'apparaît dans aucun journal.

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

> Le jeton n'est affiché **que sur un terminal**. Lancé comme service, Maestro
> indique où le lire : la bannière part sinon dans le journal du système, qui est
> persistant et lisible au-delà de l'utilisateur courant.

## Exploitation

Un orchestrateur doit tourner en continu, survivre à une fermeture de terminal et
repartir après un redémarrage. Un cron qui ne s'exécute que quand une fenêtre est
ouverte ne surveille rien.

### Service utilisateur (recommandé sur un poste)

```bash
npm run service -- install     # installe et démarre
npm run service -- status      # état rapporté par le système
npm run service -- print       # affiche l'unité sans rien installer
npm run service -- uninstall   # arrête et retire ; les données restent
```

Génère une unité **systemd `--user`** sous Linux, un **LaunchAgent** sous macOS.

**Pourquoi un service utilisateur et non système** : Maestro réutilise
l'authentification Claude de la machine, qui vit dans le répertoire personnel
(`~/.claude`, ou les profils de comptes sous `<dataDir>/accounts`). Une unité
tournant sous `root` ou sous un compte de service démarrerait, puis échouerait
sur « Not logged in » à chaque run.

Contrepartie assumée : un service utilisateur s'arrête à la déconnexion.
L'installateur active donc la persistance de session (`loginctl enable-linger`),
et la désinstallation ne la retire pas — d'autres services peuvent en dépendre.

Ce que l'unité impose, et pourquoi :

| Réglage                       | Raison                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `MAESTRO_HOST=127.0.0.1`      | 🔒 un service qui démarre au boot n'a que son jeton pour barrière : publie par un reverse proxy                       |
| `Restart=on-failure`          | un arrêt demandé sort en code 0 et ne doit pas être relancé, sinon le service devient inarrêtable                     |
| `TimeoutStopSec=30`           | Maestro traite SIGTERM : il clôt ses sessions et ferme la base avant de sortir                                        |
| `--env-file-if-exists`        | le dotenv est chargé par Node — **aucun secret n'entre dans le fichier d'unité**, lisible par les autres utilisateurs |
| `After=network-online.target` | Maestro joint des API dès son démarrage ; repartir trop tôt produit une minute d'échecs inutiles                      |

### Conteneur

```bash
docker compose up -d --build
```

**À savoir avant de construire** : un conteneur **n'hérite pas d'un abonnement
Claude**. L'authentification réaliste y est une **clé d'API**
(`ANTHROPIC_API_KEY`). Se dégradent aussi : le radar de sessions ne voit que le
conteneur, le bac à sable d'agent exige des capacités absentes, et tmux ne
s'attache que depuis l'intérieur.

Autrement dit : l'image sert un déploiement serveur piloté par clé d'API ; pour
un poste de travail avec abonnement, le service utilisateur est le bon outil.

Le `compose.yml` publie volontairement sur `127.0.0.1:4520` — l'exposition se
décide par le reverse proxy, pas par défaut. 🔒 En production, remplace `build`
par une image versionnée du registre interne, jamais `latest`.

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
│   ├── telegram.ts      Bot long-polling (zéro dépendance)
│   └── tmux.ts          Sessions attachables
└── web/      React 19 · Vite · zustand · d3-force — thème « mission control »
```

**Principe temps réel** : toutes les mutations passent par l'API REST ; le WebSocket
(`/ws`) est un flux descendant d'événements (`run.event`, `approval.requested`,
`task.updated`, `metrics.tick`…) qui tient l'interface à jour.

**Outils MCP exposés à chaque agent** (`mcp__maestro__*`) :
`task_create`, `task_update`, `send_to_agent`, `memory_save`, `report`.

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
