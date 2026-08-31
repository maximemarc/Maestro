# Maestro — ouverture aux autres acteurs & écart avec OpenClaw

_Analyse du 27/08/2026. **Mise à jour du 27/08/2026 : les lots A1 et « hygiène »
sont livrés** — voir « État d'avancement » en fin de document._

---

## Partie 1 — Rendre les outils consommables par Codex, OpenCode & co.

### Le verrou technique, en une phrase

Les outils de Maestro (`maestro_*`, `rag_*`, outils maison) sont construits avec
`createSdkMcpServer()` du Claude Agent SDK — ce sont des serveurs MCP **in-process**,
qui n'existent que dans la mémoire du processus Node pendant un run SDK
(`runs.ts:394` → `mcpServers` passé aux `Options`). Ils ne sont **ni un processus
stdio, ni un endpoint HTTP**. Aucun client MCP tiers ne peut donc les atteindre :
il n'y a rien à joindre.

Deuxième verrou, indépendant : `AgentEngine = 'sdk' | 'tmux'` (`shared/src/types.ts:23`)
— les deux moteurs lancent `claude`. Le radar _détecte_ Codex, OpenCode, Gemini,
Aider, Cursor, Goose (`radar.ts:70-94`), mais Maestro ne sait pas les _piloter_.

D'où deux chantiers de nature très différente, à ne pas confondre.

### Chantier A — Exposer les outils Maestro en MCP standard ⭐ recommandé

> **A1 livré.** `mcp-gateway.ts` (noyau), `mcp-http.ts` (`POST /mcp`) et
> `bin/maestro-mcp.mjs` (pont stdio). Ce qui suit reste la description du
> chantier ; les écarts entre le plan et la livraison sont notés en fin de
> document.

**Objectif** : n'importe quel client MCP (Codex CLI, OpenCode, Gemini CLI, Goose,
Cursor, Windsurf, Zed…) déclare Maestro comme serveur et récupère kanban,
délégation, mémoire, RAG et outils maison.

**Deux transports, même noyau**

| Transport       | Forme                                                                             | Consommateur type                              |
| --------------- | --------------------------------------------------------------------------------- | ---------------------------------------------- |
| `stdio`         | binaire `maestro-mcp` (bin du paquet serveur) qui parle à l'API REST via le token | Codex, OpenCode, Goose, Cursor — config locale |
| Streamable HTTP | `POST /mcp` sur le Fastify existant, auth `Bearer` déjà en place (`index.ts:97`)  | clients distants, autres machines              |

`@modelcontextprotocol/sdk` est déjà présent en transitif — il suffit de le
promouvoir en dépendance directe.

**Le vrai point dur : le contexte de run.** `mcp-control.ts` construit ses outils
autour d'un `RunContext { runId, agent, depth }`. Hors run SDK, ce contexte
n'existe pas. Trois décisions à prendre :

1. **Identité** — un jeton d'agent dédié (ou header `X-Maestro-Agent`) qui dit
   _au nom de quel agent Maestro_ le client tiers agit. Sans ça, `send_to_agent`,
   `memory_save` et le filtrage des collections RAG n'ont pas de sens.
2. **Session** — une session MCP externe = un `Run` Maestro d'origine `external`.
   C'est ce qui rend la session visible dans Mission Control, comptabilisée, et
   annulable. Sans ça, un agent Codex agit dans l'angle mort de l'orchestrateur.
3. **Approbations** — un client tiers ne passe pas par `canUseTool`. Les outils
   sensibles doivent donc appeler le broker **depuis l'outil lui-même** et
   attendre la résolution web/Telegram. C'est plus de travail, mais plus robuste :
   la politique d'approbation cesse de dépendre du client.

**Gain immédiat, coût faible** : RAG et outils maison n'ont pas besoin de
`RunContext` — juste de la liste des collections/outils autorisés. Ils se
réexposent quasi gratuitement. C'est le premier lot à livrer.

### Chantier B — Piloter d'autres CLI comme moteurs de run

**Objectif** : un agent Maestro dont le moteur est `codex` ou `opencode`.

Remplacer l'énumération `'sdk' | 'tmux'` par un moteur `cli` + un **adaptateur
par acteur**, décrivant : commande et flags non-interactifs, format de sortie
streamée, mode de déclaration MCP, reprise de session, extraction tokens/coût.

**Ce qu'on perd, acteur par acteur — à assumer explicitement :**

- **Permissions interceptées** : aucun équivalent universel de `canUseTool`.
  Repli sur le sandbox natif de chaque outil → la politique `guarded` de Maestro
  devient déclarative, pas exécutoire. C'est une régression de sécurité qu'il
  faut afficher dans l'UI, pas masquer.
- **Streaming fin** : chaque CLI a son format (`codex --json`, protocole propre
  d'OpenCode…). Le transcript sera plus grossier.
- **Coût et tokens** : formats hétérogènes, parfois absents.

**Point d'ancrage commun** : tous ces outils savent consommer du MCP. C'est
pourquoi **A doit précéder B** — A donne de la valeur aux utilisateurs de Codex
sans que Maestro ait à piloter Codex.

---

## Partie 2 — Écart avec OpenClaw

Rappel de cadrage : OpenClaw (ex-Clawdbot/Moltbot, MIT) est un **assistant
personnel passerelle** — un daemon Node unique, port 18789, qui branche un modèle
sur 29 canaux de messagerie. Maestro est un **orchestrateur d'agents de code**.
Les deux se recouvrent sur : daemon local, état local, skills `SKILL.md`, cron,
mémoire fichier, approbations. Le tableau ne compare que cette zone commune.

### Manques réels de Maestro

| #   | Manque                                         | OpenClaw                                                                              | Maestro                                                                         | Poids                            |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------- |
| 1   | **Multi-fournisseurs**                         | Anthropic, OpenAI, Google, Ollama, LM Studio ; routage dynamique + chaîne de fallback | verrouillé Anthropic via Claude Code                                            | **fort**                         |
| 2   | **Canaux**                                     | 29 (WhatsApp, Discord, Slack, Signal, iMessage, e-mail…)                              | Telegram seul, dans un `telegram.ts` monolithique — pas d'abstraction « canal » | **fort**                         |
| 3   | **Isolation / sandbox**                        | sandboxing optionnel, containers d'exécution                                          | aucune : un agent `bypassPermissions` a la machine                              | **fort**                         |
| 4   | ~~**Autonomie proactive**~~ **comblé**         | heartbeat : le daemon lit `HEARTBEAT.md` et **décide** quoi faire                     | battement de cœur : état des lieux + `HEARTBEAT.md`, l'agent décide             | moyen                            |
| 5   | ~~**Installation / exploitation**~~ **comblé** | `curl \| bash`, `onboard --install-daemon`, systemd/LaunchAgent, Docker               | `npm run service -- install` (systemd user / LaunchAgent), Dockerfile + compose | moyen, **peu coûteux à combler** |
| 6   | **Fédération inter-machines**                  | plugin A2A : découverte DNS-SD, circuit breaker                                       | `send_to_agent` intra-instance uniquement                                       | moyen                            |
| 7   | **Clients natifs**                             | app macOS, iOS/Android, Canvas                                                        | web responsive derrière reverse proxy                                           | faible                           |
| 8   | **Pilotage navigateur**                        | intégré                                                                               | absent (délégable à un MCP tiers)                                               | faible                           |

Les manques 1 et 2 sont **le même problème que la Partie 1** vu sous un autre
angle : une architecture à un seul fournisseur et un seul canal.

### Ce que Maestro a et qu'OpenClaw n'a pas

Kanban piloté par les agents (`maestro_task_update`), pipelines multi-agents,
Mission Control + radar de sessions, approbations granulaires **par outil** avec
historique et double canal, RAG hybride intégré avec graphe de proximité,
garde-fous par agent (tours / délai / budget de tokens), analytique de coûts,
et surtout des **garde-fous d'import** qu'OpenClaw n'a pas : allowlist d'hôtes,
refus des redirections hors allowlist, prévisualisation obligatoire. Sur ce
dernier point l'écart joue en faveur de Maestro — 26 % des skills OpenClaw
auditées par Cisco portaient au moins une vulnérabilité, et 230+ skills
malveillantes ont été publiées la première semaine de février 2026.

### Note de sécurité — vérification faite, pas de faille équivalente au CVE OpenClaw

CVE-2026-25253 (CVSS 8.8) frappait OpenClaw par _cross-site WebSocket hijacking_
menant à RCE. J'ai vérifié le `/ws` de Maestro : **non vulnérable au même
scénario**, parce que l'authentification n'est pas ambiante — le jeton transite
en header `Bearer` ou en paramètre de requête, jamais en cookie, donc une page
tierce ne peut pas forger de connexion authentifiée.

Deux points d'hygiène subsistent quand même :

- le jeton accepté en **query string** (`index.ts:100`) fuit dans les logs
  serveur, les logs de reverse proxy et l'historique du navigateur ;
- `fastifyCors({ origin: true })` (`index.ts:92`) reflète n'importe quelle
  origine. Sans `credentials: true` ce n'est pas exploitable aujourd'hui, mais
  c'est plus large que nécessaire et ça devient dangereux si l'auth évolue.

Aucun des deux n'est urgent. Les mentionner maintenant coûte moins cher que de
les découvrir après avoir ouvert `/mcp` sur le réseau — ce que fait le chantier A.

---

## Ordre recommandé

1. ~~**A1** — RAG + outils maison en MCP stdio et HTTP~~ — **livré**.
2. ~~**A2** — outils de contrôle (`task_*`, `send_to_agent`, `memory_save`) avec
   identité d'agent, run externe et approbations côté serveur~~ — **livré**.
3. ~~**Hygiène** — jeton hors query string, CORS restreint~~ — **livré**, avant
   l'ouverture de `/mcp` comme prévu.
4. **B** — moteur `cli` + adaptateurs Codex/OpenCode, en affichant la perte de
   contrôle sur les permissions.
5. **Abstraction canal** — extraire une interface de `telegram.ts`, condition
   préalable à tout autre canal.

---

## État d'avancement — 27/08/2026

### A1 — passerelle MCP standard ✅

| Élément                                    | Fichier                                   |
| ------------------------------------------ | ----------------------------------------- |
| Noyau : périmètre, catalogue, exécution    | `packages/server/src/mcp-gateway.ts`      |
| Transport Streamable HTTP (`POST /mcp`)    | `packages/server/src/mcp-http.ts`         |
| Pont stdio (`maestro-mcp`)                 | `packages/server/bin/maestro-mcp.mjs`     |
| Projection JSON Schema des outils maison   | `packages/server/src/mcp-schema.ts`       |
| Tests (20 + 5, dont un handshake MCP réel) | `mcp-gateway.test.ts`, `mcp-http.test.ts` |

**Décisions prises pendant la mise en œuvre**, là où l'analyse laissait le choix :

- **Identité** → en-tête `X-Maestro-Agent`, facultatif. Sans lui, le périmètre est
  celui du jeton (qui ouvre déjà l'API REST complète, donc aucun privilège
  nouveau) ; avec lui, celui de l'agent nommé. L'alternative « jeton d'agent
  dédié » restait ouverte mais aurait demandé un cycle de vie de jetons pour un
  lot qui n'en avait pas besoin.
- **Session** → aucune. Le mode _sans état_ du transport évite de stocker,
  d'expirer et de restaurer des sessions MCP, et fait recalculer le périmètre à
  chaque appel : retirer une collection à un agent prend effet immédiatement. La
  contrepartie — pas de run `external` visible dans Mission Control — appartient
  à A2, qui en a besoin pour les outils de contrôle.
- **Approbations** → un outil maison marqué `requiresApproval` est **annoncé mais
  refusé**, avec son motif. C'était le seul choix honnête sans broker : exécuter
  reviendrait à contourner en silence une garantie affichée dans l'interface.
- **Serveurs MCP externes** → non relayés. Un client tiers sait les déclarer
  lui-même ; en faire un proxy ajouterait un saut réseau et une couche de pannes.

**Trouvé en conditions réelles, hors analyse initiale** : la spécification HTTP
ne connaît pas l'UTF-8 dans une valeur d'en-tête — ce sont des octets latin-1.
`X-Maestro-Agent: Développeur` arrivait donc en `DÃ©veloppeur`, ce qui rendait
l'en-tête inutilisable pour des agents aux noms français. La résolution tente
maintenant la lecture recodée et compare sans casse ni diacritiques.

### Hygiène ✅

- Le jeton en paramètre de requête n'est plus accepté que sur `/ws`, où l'API
  navigateur interdit les en-têtes. Vérifié : `/ws?token=` répond 101,
  `/api/...?token=` et `/mcp?token=` répondent 401, le front n'est pas affecté.
- `fastifyCors({ origin: true })` devient une liste d'origines
  (`MAESTRO_ALLOWED_ORIGINS`, par défaut les origines locales du serveur et du
  proxy Vite).

### Reste à faire

- ~~**A2** — outils de contrôle, run d'origine `external`, broker d'approbation
  appelé depuis l'outil~~ — **livré**, voir ci-dessous.
- ~~**B** — moteur `cli` et adaptateurs~~ — **livré**, voir ci-dessous.
- ~~**Abstraction canal** — extraction d'une interface de `telegram.ts`~~ —
  **livré**, voir ci-dessous. Tous les lots de l'analyse initiale sont traités.

---

## Chantier B & manque n°1 — livrés le 31/08/2026

Le chantier B et le manque n°1 (« multi-fournisseurs ») se sont avérés être le
même travail : ce n'est pas l'énumération `AgentEngine` qui verrouillait Maestro
sur un fournisseur, c'est l'absence de la notion de **compte**. Un run est
désormais « une tentative sur un compte d'un fournisseur ».

| Élément                                       | Fichier                                     |
| --------------------------------------------- | ------------------------------------------- |
| Vocabulaire partagé (comptes, classes, plans) | `packages/shared/src/providers.ts`          |
| Classification des échecs                     | `packages/server/src/providers/failure.ts`  |
| Routeur de repli (module pur)                 | `packages/server/src/providers/policy.ts`   |
| Registre : comptes, politiques, santé, env    | `packages/server/src/providers/registry.ts` |
| Adaptateur CLI générique (Codex, OpenCode)    | `packages/server/src/providers/cli.ts`      |
| Adaptateur API HTTP (Anthropic / OpenAI)      | `packages/server/src/providers/http-api.ts` |
| Sonde Claude & profils multi-comptes          | `packages/server/src/providers/claude.ts`   |
| Résumés de reprise                            | `packages/server/src/providers/handoff.ts`  |
| Boucle de tentatives                          | `packages/server/src/runs.ts`               |
| Interface (comptes, politiques, onboarding)   | `packages/web/src/pages/ProvidersPage.tsx`  |

**Décisions prises pendant la mise en œuvre**, là où l'analyse laissait le choix :

- **Multi-comptes Claude** → `CLAUDE_CONFIG_DIR`, vérifié avant d'être codé : un
  répertoire par compte isole entièrement l'authentification, donc le quota. Un
  compte peut aussi être une clé d'API, désignée par le **nom** de sa variable
  d'environnement — la valeur n'entre jamais en base, même règle que les clés
  d'embeddings du RAG.
- **Quota** → basculer plutôt qu'attendre. Attendre n'a lieu que si personne ne
  peut prendre le relais, et seulement sur une réouverture _annoncée_. Les
  formulations en prose (« resets at 5pm ») ne sont pas interprétées : sans
  fuseau explicite, une heure devinée vaut moins qu'un backoff honnête.
- **`claude-sdk` n'est pas un adaptateur** comme les autres : son exécution
  reste dans `runs.ts`, tissée avec les serveurs MCP in-process, les plugins et
  le broker d'approbations. Le déplacer derrière l'interface aurait fait
  transiter la moitié du moteur en paramètre. Il respecte le même type de
  sortie, ce qui suffit à la boucle de repli.
- **Handoff** → seuil _et_ filet. Le filet n'est pas un repli théorique : quand
  tous les comptes sont en quota, plus aucun modèle ne peut rédiger le résumé.
  Le résumé mécanique, reconstruit depuis les événements, est marqué `degraded`.

**Trouvés en conditions réelles, hors analyse initiale** — trois défauts qu'aucun
test unitaire n'aurait produits :

1. Un processus CLI tué laisse ses petits-enfants tenir les tuyaux ouverts :
   l'événement `close` n'arrive jamais et le run reste suspendu indéfiniment.
   Corrigé par un groupe de processus (`detached`) et un délai de grâce sur `exit`.
2. `claude auth status` **sort en code 1** quand le profil n'est pas connecté,
   tout en imprimant un JSON valide. Maestro concluait « la commande n'a pas
   répondu » là où la réponse était « ce profil n'est pas authentifié » — deux
   diagnostics qui n'appellent pas la même action.
3. Le plus grave : lancé sur un profil non authentifié, le SDK rend un résultat
   de sous-type **`success`** dont le texte est « Not logged in · Please run
   /login », avec zéro token. Le run finissait **vert**, aucun repli ne se
   déclenchait, et ce message était livré comme réponse de l'agent. Garde-fou
   retenu : aucun appel de modèle n'est gratuit — un résultat qui n'a consommé ni
   entrée, ni sortie, ni cache n'a pas été produit par un modèle, et son texte est
   alors soumis à la classification.

**Vérification de bout en bout** (instance jetable, port 4599) : une politique
« compte non authentifié → compte serveur » sur un agent réel. Tentative 1
classée `auth` en 4,5 s, résumé de reprise rédigé, tentative 2 réussie avec le
résultat attendu, compte fautif automatiquement marqué `unauthenticated` — donc
écarté d'emblée aux runs suivants.

**Invocation des moteurs CLI : déduite, pas codée en dur.** Le premier jet
embarquait une suite d'arguments pour Codex et OpenCode, avec la mention « à
vérifier contre la version installée ». C'était reporter le problème sur
l'utilisateur : leurs options changent d'une version à l'autre, et celui qui
tombe sur un écart doit deviner quoi corriger.

`cli-invocation.ts` lit donc `<outil> --help` — puis l'aide de la sous-commande,
plus précise — et **n'émet que ce que le binaire déclare**. Sous-commande,
`--json`, `--model`, forme du prompt (positionnel ou par option) : chaque
élément n'est ajouté que s'il figure dans l'aide. Une option disparue est
ignorée, une option renommée n'est pas inventée. Le champ « Arguments » d'un
compte ne sert plus qu'à **imposer** une ligne de commande, et vide signifie
« détecte ».

Deux points tranchés au passage :

- **Aucun contournement d'approbation n'est ajouté automatiquement.**
  `--full-auto` et ses équivalents sont repérés dans l'aide et signalés à
  l'opérateur, jamais activés. Sur un moteur où Maestro n'intercepte déjà plus
  les outils, ajouter le second abandon à sa place serait une décision de
  sécurité prise par une heuristique.
- **Le repli est minimal, et se déclare tel quel.** Si l'aide est illisible, on
  lance la sous-commande candidate et le prompt, rien de plus, avec un drapeau
  `degraded` visible dans la sonde et dans le transcript. Une suite d'options
  inventées échouerait de façon plus obscure.

La reconnaissance est testée sur les trois styles d'aide répandus (clap,
commander, cobra) et sur un vrai binaire écrit pour l'occasion — dont l'aide
part sur stderr avec un code de retour 1, cas fréquent qu'un lecteur naïf prend
pour une absence de réponse.

## Partie 2, manque n°4 — autonomie proactive, livré le 31/08/2026

Une routine cron **déclenche** un prompt écrit d'avance. Un battement de cœur
dresse un **état des lieux**, le confie à un agent avec ses consignes permanentes
(`HEARTBEAT.md` dans son workspace), et le laisse **décider** s'il y a lieu
d'agir — y compris conclure que non. Toute la différence tient dans ce dernier
point : un cron agit toujours.

### Aucune nouvelle surface d'action

Un battement **est un run**. L'agent agit par les outils MCP qu'il a déjà :
kanban, délégation, mémoire. C'est délibéré — sa politique d'approbation et ses
outils autorisés bornent la délibération exactement comme ils bornent le reste.
Un canal d'action réservé au battement échapperait à ces garde-fous.

### Le mode d'échec principal, et sa parade

Sans mémoire de ses propres décisions, un agent qui délibère toutes les heures
recrée la même carte kanban vingt-quatre fois par jour : il n'a aucun moyen de
savoir qu'il l'a déjà créée. Les comptes rendus des battements précédents sont
donc réinjectés dans l'état des lieux. C'est la pièce sans laquelle la
fonctionnalité serait activement nuisible — et elle est vérifiée en réel.

### 🔒 Les garde-fous ne sont pas des options

Un orchestrateur qui délibère dépense des tokens sans que personne n'ait rien
demandé. C'est un changement de nature, pas une commodité de plus.

| Garde-fou                         | Raison                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| **désactivé par défaut**          | l'autonomie se demande, elle ne s'hérite pas                                                        |
| **agent dédié**                   | ses permissions bornent ce que la délibération peut faire                                           |
| **plancher de 5 minutes**         | délibérer plus souvent coûterait plus que ça ne rapporte                                            |
| **plafond quotidien**             | garde-fou de facture, indépendant du rythme                                                         |
| **budget de tokens de l'agent**   | un battement _est_ un run : inutile d'inventer un second compteur                                   |
| **rien pendant qu'un run tourne** | une délibération lancée sur du travail en cours juge un état déjà périmé                            |
| **céder le quota**                | consommer la fin d'une fenêtre pour un battement plutôt que pour un humain serait le pire arbitrage |
| **pas d'empilement**              | deux délibérations concurrentes décideraient deux fois la même action                               |

L'ordre d'évaluation compte et est testé : la configuration avant l'état du
système, pour qu'un battement désactivé ne fasse ni mesurer un quota ni
interroger la base.

### Une issue qui distingue « a agi » de « rien à faire »

Un battement qui conclut à l'inaction est un **succès**, et l'historique doit le
dire — sinon impossible de juger si la délibération sert à quelque chose.
L'issue est donc reclassée après coup, à partir du compte rendu de l'agent. La
reconnaissance est une heuristique étroite et faillible, qui ne sert qu'à
l'affichage et à la mémoire : en cas de doute, le battement est compté comme
ayant agi, parce que surestimer l'activité est moins trompeur que de la masquer.

### Vérifié en conditions réelles

Instance jetable, agent « Veilleur » sur haiku avec budget de tokens :
désactivé au départ ; rythme `* * * * *` refusé en 400 avec son motif ;
battement sans agent sauté avec sa raison ; après activation, état des lieux
assemblé correctement ; battement réel → l'agent conclut « Aucune action
requise », et l'issue **se reclasse de `acted` en `idle`** ; son compte rendu
réapparaît bien dans l'état des lieux suivant.

## Partie 2, manque n°5 — exploitation, livré le 31/08/2026

Maestro se lançait à la main. Un orchestrateur censé tenir un cron, surveiller
des sessions et notifier des fins de run, mais qui s'arrête quand on ferme le
terminal, contredit sa propre promesse. C'était l'écart le plus incohérent de la
Partie 2, et le moins risqué à combler.

### Le choix qui structure tout : un service _utilisateur_

Maestro réutilise l'authentification Claude de la machine, qui vit dans le
répertoire personnel (`~/.claude`, ou les profils de comptes sous
`<dataDir>/accounts`). Une unité système sous `root` ou sous un compte de
service démarrerait sans problème, puis échouerait sur « Not logged in » à
chaque run — l'échec le plus déroutant possible, puisque tout aurait l'air
correct.

D'où `systemd --user` sous Linux et un LaunchAgent sous macOS. Contrepartie
assumée et signalée : un service utilisateur s'arrête à la déconnexion, sauf
persistance (`loginctl enable-linger`) — que l'installateur active, et que la
désinstallation ne retire pas, d'autres services pouvant en dépendre.

| Élément                             | Fichier                               |
| ----------------------------------- | ------------------------------------- |
| Génération d'unité, install/retrait | `packages/server/src/service.ts`      |
| Tests des unités générées           | `packages/server/src/service.test.ts` |
| Image                               | `Dockerfile`, `.dockerignore`         |
| Déploiement conteneur               | `compose.yml`                         |

### Trois décisions de sécurité, portées par le code

- **`MAESTRO_HOST`** existe désormais, et l'unité générée impose `127.0.0.1`. Un
  service qui démarre au boot en écoutant sur toutes les interfaces n'aurait que
  son jeton pour barrière. Le défaut global reste `0.0.0.0` : le changer aurait
  coupé l'accès de qui atteint Maestro depuis son réseau local. Le défaut
  prudent va aux nouvelles installations, sans casser les existantes.
- **Aucun secret dans l'unité.** Le dotenv est chargé par Node
  (`--env-file-if-exists`), pas par le gestionnaire de service. Un fichier
  d'unité — et plus encore un plist macOS — est lisible par les autres
  utilisateurs de la machine. C'est aussi ce qui résout l'absence
  d'`EnvironmentFile` chez launchd sans y inscrire de clé.
- **`Restart=on-failure`, pas `always`.** Un arrêt demandé sort en code 0 ;
  le relancer rendrait le service impossible à arrêter.

### Deux défauts trouvés en installant pour de vrai

1. **Le jeton d'accès partait dans le journal systemd.** La bannière de
   démarrage l'affiche — anodin sur un terminal, inacceptable dans un journal
   persistant lisible au-delà de l'utilisateur courant. Il n'est désormais
   affiché que si la sortie est un terminal ; sinon Maestro indique où le lire.
2. **Le conteneur sortait en code 1 sur SIGTERM.** Avec `CMD ["npm", "start"]`,
   npm en PID 1 ne relaie pas proprement le signal et rapporte la fin de son
   fils comme une erreur : tout arrêt demandé passait pour un plantage, et une
   politique de redémarrage sur échec aurait bouclé. Node est maintenant PID 1 —
   avec `init: true` en contrepartie, puisque Node ne récolte pas les zombies et
   que Maestro lance des fils.

Ajouté au passage : l'arrêt est devenu **idempotent**. Un gestionnaire de
service qui renvoie SIGTERM trouvait une base déjà fermée et transformait un
arrêt propre en plantage.

### Vérifié en conditions réelles

- Unité validée par `systemd-analyze verify` (code 0, aucun avertissement).
- Service installé, démarré, redémarré et arrêté sous `systemctl --user` :
  actif, `Result=success`, code de sortie 0. Écoute confirmée par `ss` sur
  `127.0.0.1:4520` uniquement — sans le garde-fou, c'eût été `0.0.0.0`.
- Image construite (901 Mo), conteneur `healthy`, utilisateur non privilégié
  `node`, `claude`/`git`/`tmux` présents, arrêt en code 0 après correction.
- Machine remise en l'état : service désinstallé, image et conteneurs d'essai
  supprimés. Seul résidu, signalé : `Linger` reste actif pour l'utilisateur.

**Ce que l'image ne peut pas faire, et qui est écrit dans le Dockerfile** : un
conteneur n'hérite pas d'un abonnement Claude. L'authentification réaliste y est
une clé d'API. Le radar ne voit que le conteneur, le bac à sable exige des
capacités absentes, et tmux ne s'attache que de l'intérieur. L'image sert un
déploiement serveur ; pour un poste avec abonnement, le service utilisateur est
le bon outil.

## Abstraction canal — livrée le 31/08/2026

`telegram.ts` mêlait quatre choses, dont une seule était telegramienne : l'API et
le long-polling. Les trois autres — décider qu'un run mérite une notification,
mettre en forme le message, exécuter `/agents`, `/status`, `/run` — sont de la
logique d'orchestrateur. Un second canal les aurait recopiées.

**La décision qui structure tout : un message n'est pas du texte.** Le code
d'origine fabriquait directement du HTML Telegram, chaîne inutilisable ailleurs —
`<b>` s'affiche littéralement dans Discord, et les boutons n'ont d'équivalent
nulle part. Un message est désormais une **structure** (titre, ton, faits, corps,
actions) que chaque canal rend selon ses moyens.

| Fichier                | Rôle                                                   |
| ---------------------- | ------------------------------------------------------ |
| `channels/types.ts`    | contrat `Channel`, message structuré, rendu texte brut |
| `channels/messages.ts` | quoi notifier, commandes — sans transport              |
| `channels/registry.ts` | un seul abonnement au bus, diffusion isolée par canal  |
| `channels/telegram.ts` | transport et rendu HTML, rien d'autre                  |
| `channels/webhook.ts`  | Slack / Discord / brut, sortant                        |

**Un second canal, pour que l'interface soit éprouvée et non supposée.** Une
abstraction à une seule implémentation ne prouve rien. Le webhook sortant
confronte le contrat à un transport qui ne ressemble en rien à Telegram : pas de
réception, pas de boutons, une charge utile différente par service. C'est ce qui
a fait apparaître la distinction `interactive` — un canal sortant ne peut pas
résoudre une approbation, il doit dire où aller.

**Deux choix de sécurité, tenus dans le code :**

- 🔒 Le webhook n'envoie **que l'état** par défaut — agent, statut, coût. Le
  résultat d'un run peut porter du code ou des noms de clients, et l'expédier
  vers un service tiers est une publication. `MAESTRO_WEBHOOK_DETAIL=full` est
  un choix explicite de l'opérateur.
- 🔒 L'URL d'un webhook vaut un mot de passe : elle reste en variable
  d'environnement, et n'est jamais écrite dans les journaux — qui sont lisibles
  depuis l'interface.

**Ce qui n'a pas bougé, volontairement** : l'origine d'un run lancé depuis un
canal reste `telegram`. La renommer imposerait une migration des runs déjà
enregistrés pour la seule satisfaction du vocabulaire.

**Reste ouvert** : un canal **entrant** autre que Telegram. Chaque service a sa
propre enveloppe et sa propre vérification de signature — c'est un lot par
service, pas une généralisation. Le contrat est prêt à les recevoir.

## A2 — outils de contrôle pour les clients tiers, livré le 31/08/2026

Le lot A1 exposait le RAG et les outils maison, et s'arrêtait là pour une raison
précise : les outils de contrôle exigent un contexte de run qui n'existait pas
hors run, et les outils sous approbation ne pouvaient pas être exécutés sans
broker. Les deux verrous sont levés.

**Session externe.** Un run d'origine `external` est ouvert au premier geste
d'un client identifié, et refermé après quinze minutes de silence. Il n'exécute
rien — le travail se fait chez le client tiers, dont Maestro n'a ni le
transcript, ni les tokens, ni le coût. Il sert de **journal** : une ligne dans
Mission Control, un parent pour les délégations, une prise pour l'annulation.

Une session par agent, et non par appel : le transport Streamable HTTP est sans
état, il n'y a pas d'identifiant de session à suivre, et un run par appel
noierait la liste sous des dizaines de lignes d'une ligne.

**Approbations réelles.** Un outil maison marqué `requiresApproval` n'est plus
refusé : il passe par le même broker que pour un agent Maestro — même file, même
historique, même résolution web ou Telegram. L'appel MCP attend la décision.
Sans agent identifié, Maestro n'a personne à qui la demander et refuse.

**Ce qui n'a pas été dupliqué.** La logique des actions vit désormais dans
`mcp-actions.ts`, partagée par le serveur MCP in-process et la passerelle. La
délégation porte les garde-fous anti-cascade — profondeur maximale, refus de
l'auto-délégation, plafond de concurrence — et en tenir deux copies aurait
garanti qu'une des deux dérive. Un client Codex échappant à la limite de
profondeur pourrait déclencher une cascade que rien n'arrête.

**Ce qu'annuler veut dire, dit franchement.** Annuler une session externe annule
en cascade les runs qu'elle a délégués — c'est le geste utile, et il fonctionne.
Elle ne coupe pas le client tiers, que Maestro ne pilote pas : un nouvel appel
rouvre une session. Le message d'annulation le dit, plutôt que de laisser croire
à un coupe-circuit.

🔒 **Limite à ne pas masquer** : la passerelle ne voit que les appels qui lui
sont adressés. Un client tiers qui lit et écrit des fichiers le fait avec ses
propres outils, hors de portée de Maestro. La gouvernance porte sur le canal
Maestro, pas sur la machine.

**Corrigé au passage** : un run actif que le moteur ne pilote pas — une session
externe — ne pouvait pas être annulé du tout. `cancel()` ne connaissait que ses
runs actifs et sa file ; tout le reste restait « en cours » à vie, sans prise.

**Vérification de bout en bout**, avec un vrai client MCP parlant en Streamable
HTTP : sans en-tête d'agent, aucun outil de contrôle annoncé ; avec, les quatre
outils apparaissent, `task_create` crée une carte attribuée à l'agent, la
session externe apparaît dans les runs, l'action est journalisée dans son
transcript (nom de l'outil et issue — jamais les arguments, qui peuvent
contenir un prompt entier diffusé à tous les clients connectés), l'annulation
depuis Maestro la referme, et l'appel suivant en rouvre une.

## Anticipation des quotas — livrée le 31/08/2026

Le repli fonctionnait, mais toujours _après_ le mur : un run entamé, un contexte
perdu, un résumé à reconstruire. Il manquait de savoir que la limite approche.

**Ce qui n'existe pas, vérifié avant d'écrire du code.** Il n'y a pas de
`/usage` programmatique : ni sous-commande, ni endpoint. `stats-cache.json`
contient bien des totaux par jour et par modèle, mais c'est un cache recalculé
de loin en loin — celui de la machine de développement datait de vingt jours. Il
fallait donc reconstruire la mesure.

**Ce qui existe** : les transcripts portent, pour chaque message d'assistant,
son horodatage, son modèle et son `usage`. Écrits en direct, rangés dans le
répertoire de configuration — donc **un jeu par profil, donc par compte** — et
surtout ils couvrent tout ce qui a tourné sur ce profil, y compris les sessions
lancées à la main hors de Maestro. C'est le seul point de vue complet.
🔒 Lecture bornée aux mêmes champs que le radar : horodatage, modèle, session,
compteurs. Jamais le contenu d'un message.

**Trois décisions qui font la différence entre une jauge utile et une jauge
trompeuse :**

- **Le cache de lecture est exclu du total.** Facturé une fraction du prix, il
  gonflerait la mesure d'un facteur dix sur une session qui relit un gros
  contexte. Mesuré sur la machine : 12,5 M de tokens facturables pour 438 M de
  cache lu sur la même fenêtre — un facteur 35. L'inclure aurait fait délaisser
  un compte parfaitement disponible.
- **Le plafond s'apprend au mur.** Aucun fournisseur ne publie celui d'un
  abonnement. Maestro retient la consommation constatée à l'instant du refus.
  Une valeur déclarée par l'opérateur l'emporte : qui connaît son contrat en
  sait plus qu'une observation.
- **Une estimation ne refuse jamais un compte.** Elle le fait passer en second
  s'il existe une alternative plus calme, et rien de plus. Quand tous les
  comptes sont chargés, l'ordre déclaré reprend la main. Refuser sur la foi d'un
  chiffre deviné priverait l'opérateur d'une ressource peut-être intacte.

**Trouvé en faisant tourner l'instance** : modifier un plafond restait sans
effet pendant une minute — la mesure est mise en cache, et rien ne l'invalidait.
L'opérateur changeait un réglage sans le voir agir, et le routage continuait de
décider sur l'ancienne valeur.

**Vérification de bout en bout** : plafond déclaré sous la consommation réelle
(126 % de pression), politique « compte chargé → compte calme », run lancé. Le
run a démarré directement sur le second compte — **aucune tentative échouée,
aucun résumé de reprise, aucune erreur**. C'est la différence entre subir la
limite et l'anticiper.

**Reste non vérifié** : le comportement des vrais Codex et OpenCode, absents de
cette machine. Ce qui est vérifié, en revanche, c'est que Maestro n'invente rien
— il ne peut passer qu'une option lue dans l'aide du binaire présent. L'adaptateur
lui-même est testé de bout en bout sur des binaires réels : commande, arguments,
découpage de la sortie, code de retour, stderr, délai maximal et interruption.
