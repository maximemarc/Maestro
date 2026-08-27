#!/usr/bin/env node
/**
 * Provisionne dans Maestro l'équipe d'agents et les pipelines de claude-index.
 *
 * Les définitions d'agents ne sont PAS recopiées : chaque agent Maestro pointe,
 * via `cliAgent`, sur la définition native (~/.claude/agents/<nom>.md, lien
 * symbolique vers claude-index). Un `git pull` dans claude-index met donc à jour
 * le comportement des agents Maestro sans rien reprovisionner — même contrat que
 * le dépôt d'origine. Ce script ne lit claude-index que pour les métadonnées de
 * présentation (description, modèle, garde-fous, couleur).
 *
 * Idempotent : relancé, il met à jour au lieu de dupliquer (appariement par nom).
 *
 * Usage :
 *   node scripts/provision-claude-index.mjs [--dry-run]
 *
 * Environnement :
 *   MAESTRO_URL        défaut http://localhost:4520
 *   MAESTRO_TOKEN      défaut : contenu de ~/.maestro/token
 *   CLAUDE_INDEX_DIR   défaut : cible du lien ~/.claude/agents, sinon ~/Projets/claude-index
 */
import { readFileSync, readdirSync, realpathSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');
const BASE_URL = (process.env.MAESTRO_URL ?? 'http://localhost:4520').replace(/\/$/, '');

// --- Résolution des sources ------------------------------------------------

function resolveAgentsDir() {
  if (process.env.CLAUDE_INDEX_DIR) return join(process.env.CLAUDE_INDEX_DIR, 'claude', 'agents');
  const linked = join(homedir(), '.claude', 'agents');
  try {
    // ~/.claude/agents est un lien vers <claude-index>/claude/agents.
    return realpathSync(linked);
  } catch {
    return join(homedir(), 'Projets', 'claude-index', 'claude', 'agents');
  }
}

function resolveToken() {
  if (process.env.MAESTRO_TOKEN) return process.env.MAESTRO_TOKEN.trim();
  const tokenFile = join(homedir(), '.maestro', 'token');
  if (!existsSync(tokenFile)) {
    throw new Error(
      `Jeton introuvable. Renseigne MAESTRO_TOKEN, ou démarre Maestro une fois pour générer ${tokenFile}.`,
    );
  }
  return readFileSync(tokenFile, 'utf8').trim();
}

const AGENTS_DIR = resolveAgentsDir();
const TOKEN = resolveToken();

// --- Métadonnées de présentation (ce que claude-index ne porte pas) --------

/** Emoji et libellé lisible, par nom d'agent claude-index. */
const PRESENTATION = {
  lead: { emoji: '🎯', label: 'Lead' },
  'symfony-expert': { emoji: '🐘', label: 'Symfony' },
  'frontend-expert': { emoji: '🎨', label: 'Front' },
  'devops-expert': { emoji: '🛠️', label: 'DevOps' },
  analyst: { emoji: '🗺️', label: 'Analyste' },
  'code-reviewer': { emoji: '🔍', label: 'Revue de code' },
  'security-auditor': { emoji: '🛡️', label: 'Sécurité' },
  'test-author': { emoji: '🧪', label: 'Tests' },
  refactorer: { emoji: '♻️', label: 'Refactorisation' },
  'qa-fixer': { emoji: '🩹', label: 'QA' },
  'mr-author': { emoji: '📝', label: 'Merge request' },
  Explore: { emoji: '🧭', label: 'Explorateur' },
};

/** Couleurs nommées de claude-index → hexadécimal du thème Maestro. */
const COLORS = {
  purple: '#a78bfa',
  blue: '#60a5fa',
  green: '#34d399',
  orange: '#fb923c',
  red: '#f87171',
  yellow: '#facc15',
  cyan: '#22d3ee',
};

/** Une session tmux interactive ne se termine pas seule : filet à 2 h. */
const TMUX_TIMEOUT_SEC = 7200;

// --- Lecture des définitions claude-index ---------------------------------

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const head = match[1];
  const get = (key) => {
    // Clé de premier niveau uniquement (ignore les blocs indentés : hooks, skills…).
    const m = head.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
    const value = m?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
    return value;
  };
  const tools = get('tools');
  // `tools: … Agent(symfony-expert, analyst, …)` énumère les subagents que cet
  // agent peut déléguer : c'est la topologie réelle, telle que claude-index la déclare.
  const delegatesTo = (tools.match(/Agent\(([^)]*)\)/)?.[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    name: get('name'),
    description: get('description'),
    model: get('model'),
    maxTurns: get('maxTurns'),
    color: get('color'),
    tools,
    isolation: get('isolation'),
    delegatesTo,
  };
}

function collectAgentFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectAgentFiles(full));
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

function buildAgentPayloads() {
  if (!existsSync(AGENTS_DIR)) {
    throw new Error(`Répertoire d'agents claude-index introuvable : ${AGENTS_DIR}`);
  }
  const payloads = [];
  for (const file of collectAgentFiles(AGENTS_DIR).sort()) {
    const fm = parseFrontmatter(readFileSync(file, 'utf8'));
    if (!fm?.name) {
      console.warn(`  ⚠ frontmatter illisible, ignoré : ${file}`);
      continue;
    }
    const pres = PRESENTATION[fm.name] ?? { emoji: '🤖', label: fm.name };
    // Un agent qui peut écrire mérite une approbation ; les auditeurs passent seuls.
    const canWrite = /\b(Write|Edit)\b/.test(fm.tools);
    payloads.push({
      cliAgent: fm.name,
      name: pres.label,
      emoji: pres.emoji,
      description: fm.description.slice(0, 500),
      // 'inherit' dans claude-index = modèle de la session appelante.
      model: !fm.model || fm.model === 'inherit' ? 'sonnet' : fm.model,
      engine: 'tmux',
      permissionMode: 'acceptEdits',
      approvalPolicy: canWrite ? 'guarded' : 'auto',
      // Le persona vient de la définition native : ne rien dupliquer ici.
      systemPrompt: null,
      memoryEnabled: canWrite || fm.name === 'lead',
      maxTurns: fm.maxTurns ? Number(fm.maxTurns) : null,
      timeoutSec: TMUX_TIMEOUT_SEC,
      color: COLORS[fm.color] ?? '#22d3ee',
      source: file.replace(homedir(), '~'),
      isolation: fm.isolation || null,
      delegatesTo: fm.delegatesTo,
    });
  }
  return payloads;
}

// --- Pipelines (doctrine claude-index) ------------------------------------

/**
 * L'ordre encode les règles du dépôt : l'analyste cartographie avant les
 * auditeurs, et jamais de refactorisation avant un filet de tests vert.
 */
const PIPELINES = [
  {
    name: 'Audit qualité complet',
    description:
      'Cartographie du périmètre, puis revue de code et audit sécurité/RGPD sur le même diff. Lecture seule de bout en bout.',
    steps: [
      {
        name: 'cartographie',
        agent: 'analyst',
        promptTemplate:
          'Cartographie le périmètre du changement suivant : {{input}}\n\nProduis les fichiers touchés, les couches concernées, les appelants et les zones à risque.',
      },
      {
        name: 'revue',
        agent: 'code-reviewer',
        promptTemplate:
          'Périmètre cartographié :\n{{prev}}\n\nRelis le diff correspondant en appliquant la skill complete-code-review.\n\nDemande initiale : {{input}}',
      },
      {
        name: 'securite',
        agent: 'security-auditor',
        promptTemplate:
          'Périmètre cartographié :\n{{steps.cartographie}}\n\nRevue fonctionnelle déjà rendue :\n{{prev}}\n\nAudit sécurité applicative et RGPD du même diff.\n\nDemande initiale : {{input}}',
      },
    ],
  },
  {
    name: 'Refactorisation sécurisée',
    description:
      "Filet de tests d'abord, refactorisation à comportement constant ensuite, puis remise au vert de castor qa. Applique la règle claude-index : jamais de refactorisation sans tests passants.",
    steps: [
      {
        name: 'filet-de-tests',
        agent: 'test-author',
        promptTemplate:
          'Écris le filet de tests PHPUnit couvrant le comportement ACTUEL de : {{input}}\n\nLes tests doivent passer avant toute modification du code de production.',
      },
      {
        name: 'refactorisation',
        agent: 'refactorer',
        promptTemplate:
          'Filet de tests en place :\n{{prev}}\n\nRefactorise à comportement constant : {{input}}\n\nLes tests doivent rester verts.',
      },
      {
        name: 'qa',
        agent: 'qa-fixer',
        promptTemplate:
          'Refactorisation effectuée :\n{{prev}}\n\nFais repasser `castor qa` au vert sans affaiblir une règle ni modifier un test.',
      },
    ],
  },
  {
    name: 'Prêt à merger',
    description:
      'Remise au vert de la suite qualité, revue de code, puis rédaction de la description de merge request.',
    steps: [
      {
        name: 'qa',
        agent: 'qa-fixer',
        promptTemplate:
          'Fais repasser `castor qa` au vert (PHP-CS-Fixer, PHPStan, PHPUnit) sur le changement en cours : {{input}}',
      },
      {
        name: 'revue',
        agent: 'code-reviewer',
        promptTemplate:
          'Suite qualité :\n{{prev}}\n\nRelis le diff courant et indique s’il est prêt à merger.\n\nContexte : {{input}}',
      },
      {
        name: 'merge-request',
        agent: 'mr-author',
        promptTemplate:
          'Revue rendue :\n{{prev}}\n\nRédige la description de la merge request pour le diff courant.\n\nContexte / ticket : {{input}}',
      },
    ],
  },
  {
    name: 'Fonctionnalité back Symfony',
    description:
      'Cadrage, implémentation côté serveur, tests associés, puis revue. Chaîne de référence pour une demande back.',
    steps: [
      {
        name: 'cadrage',
        agent: 'analyst',
        promptTemplate:
          'Cadre cette demande avant implémentation : {{input}}\n\nIdentifie les fichiers et couches à toucher, les entités concernées, les risques.',
      },
      {
        name: 'implementation',
        agent: 'symfony-expert',
        promptTemplate: 'Cadrage :\n{{prev}}\n\nImplémente la demande côté serveur : {{input}}',
      },
      {
        name: 'tests',
        agent: 'test-author',
        promptTemplate:
          'Implémentation livrée :\n{{prev}}\n\nÉcris les tests PHPUnit associés à cette fonctionnalité : {{input}}',
      },
      {
        name: 'revue',
        agent: 'code-reviewer',
        promptTemplate:
          'Tests livrés :\n{{prev}}\n\nRelis l’ensemble du changement (implémentation + tests).\n\nDemande initiale : {{input}}',
      },
    ],
  },
];

// --- Client API ------------------------------------------------------------

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} : ${data?.error ?? data?.message ?? text}`);
  }
  return data;
}

// --- Provisionnement -------------------------------------------------------

async function main() {
  console.log(`\n🎛  Provisionnement Maestro depuis claude-index`);
  console.log(`   source  : ${AGENTS_DIR.replace(homedir(), '~')}`);
  console.log(`   cible   : ${BASE_URL}${DRY_RUN ? '   (simulation)' : ''}\n`);

  const payloads = buildAgentPayloads();
  const existingAgents = DRY_RUN ? [] : await api('GET', '/api/agents?archived=1');
  const byCliAgent = new Map(existingAgents.filter((a) => a.cliAgent).map((a) => [a.cliAgent, a]));
  const idByCliAgent = new Map();

  for (const p of payloads) {
    const { source, isolation, delegatesTo, ...body } = p;
    const existing = byCliAgent.get(body.cliAgent);
    const marks = [
      body.approvalPolicy === 'guarded' ? 'écrit' : 'lecture seule',
      body.model,
      isolation === 'worktree' ? 'worktree' : null,
    ].filter(Boolean);

    if (DRY_RUN) {
      console.log(
        `  ${body.emoji} ${body.name.padEnd(16)} --agent ${body.cliAgent.padEnd(17)} ${marks.join(' · ')}`,
      );
      continue;
    }
    const { name, ...withoutName } = body;
    const saved = existing
      ? await api('PATCH', `/api/agents/${existing.id}`, withoutName)
      : await api('POST', '/api/agents', body);
    idByCliAgent.set(body.cliAgent, saved.id);
    console.log(
      `  ${existing ? '↻' : '✚'} ${body.emoji} ${body.name.padEnd(16)} --agent ${body.cliAgent.padEnd(17)} ${marks.join(' · ')}`,
    );
  }

  // Rattachement hiérarchique : un subagent délégué par un autre agent n'est pas
  // relié à l'orchestrateur mais à son parent (Maestro → lead → experts).
  const parentOf = new Map();
  for (const p of payloads) {
    for (const child of p.delegatesTo) {
      if (!parentOf.has(child)) parentOf.set(child, p.cliAgent);
    }
  }
  if (!DRY_RUN) {
    for (const [childCliAgent, parentCliAgent] of parentOf) {
      const childId = idByCliAgent.get(childCliAgent);
      const parentId = idByCliAgent.get(parentCliAgent);
      if (!childId || !parentId) continue;
      await api('PATCH', `/api/agents/${childId}`, { parentAgentId: parentId });
    }
  }
  const roots = payloads.filter((p) => !parentOf.has(p.cliAgent));
  console.log('');
  console.log('  Arborescence :');
  console.log('  Maestro');
  roots.forEach((root, rootIndex) => {
    const children = payloads.filter((p) => parentOf.get(p.cliAgent) === root.cliAgent);
    const lastRoot = rootIndex === roots.length - 1;
    console.log(`  ${lastRoot ? '└──' : '├──'} ${root.emoji} ${root.name}`);
    children.forEach((c, i) => {
      const branch = i === children.length - 1 ? '└──' : '├──';
      console.log(`  ${lastRoot ? '    ' : '│   '} ${branch} ${c.emoji} ${c.name}`);
    });
  });

  console.log('');
  if (DRY_RUN) {
    for (const p of PIPELINES) {
      console.log(`  🔗 ${p.name} : ${p.steps.map((s) => s.agent).join(' → ')}`);
    }
    console.log('\n(simulation — rien n’a été écrit)\n');
    return;
  }

  const existingPipelines = await api('GET', '/api/pipelines');
  const pipelineByName = new Map(existingPipelines.map((p) => [p.name, p]));

  for (const spec of PIPELINES) {
    const steps = spec.steps.map((s) => {
      const agentId = idByCliAgent.get(s.agent);
      if (!agentId) throw new Error(`Étape « ${s.name} » : agent ${s.agent} non provisionné`);
      return { name: s.name, agentId, skillId: null, promptTemplate: s.promptTemplate };
    });
    const body = { name: spec.name, description: spec.description, steps };
    const existing = pipelineByName.get(spec.name);
    if (existing) await api('PATCH', `/api/pipelines/${existing.id}`, body);
    else await api('POST', '/api/pipelines', body);
    console.log(
      `  ${existing ? '↻' : '✚'} 🔗 ${spec.name.padEnd(28)} ${spec.steps.map((s) => s.agent).join(' → ')}`,
    );
  }

  console.log(`\n✓ ${payloads.length} agents et ${PIPELINES.length} pipelines provisionnés.\n`);
  console.log('  Les agents tournent en session tmux attachable (tmux attach -t maestro-<runId>).');
  console.log(
    '  Les pipelines forcent le moteur SDK : un enchaînement exige des runs qui terminent.',
  );
  console.log('  Pour viser un dépôt réel : Agents → <agent> → Configuration → workspaceDir.');
  console.log('');
  const skills = await api('GET', '/api/skills');
  const native = skills.filter((s) => s.scope === 'native');
  console.log(
    `  ${native.length} skills natives détectées et sélectionnables (portée « native », lecture seule).`,
  );
  console.log(
    '  Elles ne sont pas recopiées : le CLI charge celles de claude-index, dans leur version courante.\n',
  );
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
