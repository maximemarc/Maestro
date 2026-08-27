/**
 * Service Agents : cycle de vie, workspace dédié, CLAUDE.md matérialisé,
 * mémoire persistante, clonage et gabarits.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig, AgentCreate, AgentTemplate } from '@maestro/shared';
import type { Bus } from './bus.ts';
import type { MaestroConfig } from './config.ts';
import type { Store } from './db.ts';
import { makeId, nowIso } from './util.ts';

const MEMORY_FILE = 'MEMORY.md';

const ORCHESTRATOR_PREAMBLE = `# Contexte Maestro

Tu es un agent orchestré par Maestro. **Si** les outils \`maestro_*\` figurent dans
ta session (moteur SDK ; ils sont absents d'une session tmux interactive) :
- \`maestro_task_create\` / \`maestro_task_update\` : gérer les cartes du kanban partagé ;
- \`maestro_send_to_agent\` : déléguer une sous-tâche à un autre agent (par son nom) ;
- \`maestro_memory_save\` : consigner un fait durable dans ta mémoire ;
- \`maestro_report\` : publier un résumé final structuré de ton travail.

Si une carte kanban t'est confiée (son identifiant figure dans le prompt), fais-la avancer
toi-même : passe-la en "review" quand ton travail est prêt à être relu.`;

const MEMORY_PREAMBLE = `# Mémoire persistante

Ton fichier \`MEMORY.md\` (à la racine de ton workspace) survit d'un run à l'autre.
Consulte-le en début de tâche ; utilise \`maestro_memory_save\` pour y consigner les faits
durables (décisions, préférences, état d'avancement). Ne stocke jamais de secret.`;

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    slug: 'generalist',
    name: 'Généraliste',
    emoji: '🤖',
    description: 'Agent polyvalent pour toute tâche ad hoc.',
    model: 'sonnet',
    systemPrompt:
      'Tu es un assistant polyvalent, rigoureux et concis. Vérifie tes résultats avant de conclure.',
    approvalPolicy: 'guarded',
    color: '#22d3ee',
  },
  {
    slug: 'developer',
    name: 'Développeur',
    emoji: '👨‍💻',
    description: 'Écrit et modifie du code, exécute les tests.',
    model: 'sonnet',
    systemPrompt:
      'Tu es un développeur senior. Écris du code propre et testé. Lance les tests après chaque modification significative. Explique brièvement tes choix.',
    approvalPolicy: 'guarded',
    color: '#34d399',
  },
  {
    slug: 'reviewer',
    name: 'Relecteur',
    emoji: '🔍',
    description: 'Relit du code ou des documents, ne modifie jamais rien.',
    model: 'opus',
    systemPrompt:
      'Tu es un relecteur exigeant. Tu ne modifies JAMAIS les fichiers : tu lis, tu analyses, tu rapportes tes conclusions de façon structurée (constat, gravité, recommandation).',
    approvalPolicy: 'auto',
    color: '#a78bfa',
  },
  {
    slug: 'researcher',
    name: 'Veilleur',
    emoji: '📡',
    description: 'Recherche et synthèse d’informations (web).',
    model: 'sonnet',
    systemPrompt:
      'Tu es un analyste de veille. Cherche des sources fiables, croise-les, et produis des synthèses sourcées et datées.',
    approvalPolicy: 'auto',
    color: '#fbbf24',
  },
  {
    slug: 'writer',
    name: 'Rédacteur',
    emoji: '✍️',
    description: 'Rédige documentation, rapports et contenus.',
    model: 'sonnet',
    systemPrompt:
      'Tu es un rédacteur technique. Style clair, structuré, sans jargon inutile. Adapte le ton au destinataire indiqué.',
    approvalPolicy: 'auto',
    color: '#f472b6',
  },
];

export class AgentService {
  constructor(
    private store: Store,
    private bus: Bus,
    private config: MaestroConfig,
  ) {}

  list(includeArchived = false): AgentConfig[] {
    return this.store.listAgents(includeArchived);
  }

  get(id: string): AgentConfig | null {
    return this.store.getAgent(id);
  }

  getByName(name: string): AgentConfig | null {
    return this.store.getAgentByName(name);
  }

  create(input: AgentCreate): AgentConfig {
    const id = makeId('agt');
    const workspaceDir = input.workspaceDir?.trim() || join(this.config.workspacesDir, id);
    const now = nowIso();
    const agent: AgentConfig = {
      ...input,
      id,
      workspaceDir,
      createdAt: now,
      updatedAt: now,
    };
    this.materializeWorkspace(agent);
    this.store.insertAgent(agent);
    this.bus.publish({ type: 'agent.created', payload: agent });
    this.bus.log('success', 'agents', `Agent « ${agent.name} » créé`, { agentId: agent.id });
    return agent;
  }

  update(id: string, patch: Partial<AgentCreate>): AgentConfig | null {
    const current = this.store.getAgent(id);
    if (!current) return null;
    const updated: AgentConfig = {
      ...current,
      ...patch,
      workspaceDir: patch.workspaceDir?.trim() || current.workspaceDir,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: nowIso(),
    };
    this.materializeWorkspace(updated);
    this.store.updateAgent(updated);
    this.bus.publish({ type: 'agent.updated', payload: updated });
    return updated;
  }

  clone(id: string, newName?: string): AgentConfig | null {
    const source = this.store.getAgent(id);
    if (!source) return null;
    const { id: _id, workspaceDir: _ws, createdAt: _c, updatedAt: _u, ...rest } = source;
    return this.create({
      ...rest,
      name: newName ?? `${source.name} (copie)`,
      workspaceDir: null,
    });
  }

  delete(id: string): boolean {
    const agent = this.store.getAgent(id);
    if (!agent) return false;
    this.store.deleteAgent(id);
    this.bus.publish({ type: 'agent.deleted', payload: { id } });
    this.bus.log('warn', 'agents', `Agent « ${agent.name} » supprimé`, { agentId: id });
    return true;
  }

  /**
   * Déclare un répertoire comme approuvé auprès du CLI Claude Code.
   *
   * Sans cela, le CLI ouvre son dialogue « Do you trust this folder? » à la
   * première session et attend une réponse au clavier : un run tmux resterait
   * bloqué là. On ne le fait QUE pour les workspaces créés par Maestro sous son
   * propre répertoire de données — jamais pour un dépôt de l'utilisateur, à qui
   * la décision revient.
   */
  private trustWorkspace(dir: string): void {
    if (!dir.startsWith(this.config.workspacesDir)) return;
    const configPath = join(homedir(), '.claude.json');
    try {
      const raw = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '{}';
      const config = JSON.parse(raw) as { projects?: Record<string, Record<string, unknown>> };
      const projects = config.projects ?? (config.projects = {});
      const entry = projects[dir];
      if (entry?.hasTrustDialogAccepted === true) return;
      projects[dir] = { ...entry, hasTrustDialogAccepted: true };
      // Écriture atomique : le CLI écrit dans le même fichier.
      const tmp = `${configPath}.maestro-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(config, null, 2));
      renameSync(tmp, configPath);
    } catch (err) {
      this.bus.log('warn', 'agents', `Approbation du workspace impossible : ${String(err)}`);
    }
  }

  /** Crée/actualise le workspace : CLAUDE.md, MEMORY.md, dossier skills natif. */
  materializeWorkspace(agent: AgentConfig): void {
    const dir = agent.workspaceDir;
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
    this.trustWorkspace(dir);

    const sections: string[] = [];
    if (agent.systemPrompt?.trim()) sections.push(agent.systemPrompt.trim());
    sections.push(ORCHESTRATOR_PREAMBLE);
    if (agent.memoryEnabled) sections.push(MEMORY_PREAMBLE);
    writeFileSync(join(dir, 'CLAUDE.md'), sections.join('\n\n') + '\n');

    const memoryPath = join(dir, MEMORY_FILE);
    if (agent.memoryEnabled && !existsSync(memoryPath)) {
      writeFileSync(memoryPath, '# Mémoire de l’agent\n\n(vide)\n');
    }
  }

  readMemory(agent: AgentConfig): string {
    const path = join(agent.workspaceDir, MEMORY_FILE);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }

  appendMemory(agent: AgentConfig, content: string): void {
    const path = join(agent.workspaceDir, MEMORY_FILE);
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : '# Mémoire de l’agent\n';
    writeFileSync(path, existing.trimEnd() + `\n\n- [${nowIso()}] ${content.trim()}\n`);
  }

  writeMemory(agent: AgentConfig, content: string): void {
    writeFileSync(join(agent.workspaceDir, MEMORY_FILE), content);
  }
}
