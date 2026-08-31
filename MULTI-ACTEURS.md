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

| #   | Manque                          | OpenClaw                                                                              | Maestro                                                                         | Poids                            |
| --- | ------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------- |
| 1   | **Multi-fournisseurs**          | Anthropic, OpenAI, Google, Ollama, LM Studio ; routage dynamique + chaîne de fallback | verrouillé Anthropic via Claude Code                                            | **fort**                         |
| 2   | **Canaux**                      | 29 (WhatsApp, Discord, Slack, Signal, iMessage, e-mail…)                              | Telegram seul, dans un `telegram.ts` monolithique — pas d'abstraction « canal » | **fort**                         |
| 3   | **Isolation / sandbox**         | sandboxing optionnel, containers d'exécution                                          | aucune : un agent `bypassPermissions` a la machine                              | **fort**                         |
| 4   | **Autonomie proactive**         | heartbeat : le daemon lit `HEARTBEAT.md` et **décide** quoi faire                     | cron : déclenchement déterministe, aucune délibération                          | moyen                            |
| 5   | **Installation / exploitation** | `curl \| bash`, `onboard --install-daemon`, systemd/LaunchAgent, Docker               | `npm install && npm run dev` — pas de daemon, pas de service, pas d'image       | moyen, **peu coûteux à combler** |
| 6   | **Fédération inter-machines**   | plugin A2A : découverte DNS-SD, circuit breaker                                       | `send_to_agent` intra-instance uniquement                                       | moyen                            |
| 7   | **Clients natifs**              | app macOS, iOS/Android, Canvas                                                        | web responsive derrière reverse proxy                                           | faible                           |
| 8   | **Pilotage navigateur**         | intégré                                                                               | absent (délégable à un MCP tiers)                                               | faible                           |

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
2. **A2** — outils de contrôle (`task_*`, `send_to_agent`, `memory_save`) avec
   identité d'agent, run externe et approbations côté serveur. **Prochain lot.**
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

- **A2** — outils de contrôle. Le point dur inchangé : run d'origine `external`
  et broker d'approbation appelé depuis l'outil.
- ~~**B** — moteur `cli` et adaptateurs~~ — **livré**, voir ci-dessous.
- **Abstraction canal** — extraction d'une interface de `telegram.ts`.

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

**Reste non vérifié** : le comportement des vrais Codex et OpenCode, absents de
cette machine. Ce qui est vérifié, en revanche, c'est que Maestro n'invente rien
— il ne peut passer qu'une option lue dans l'aide du binaire présent. L'adaptateur
lui-même est testé de bout en bout sur des binaires réels : commande, arguments,
découpage de la sortie, code de retour, stderr, délai maximal et interruption.
