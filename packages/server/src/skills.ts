/**
 * Registre de skills — fichiers markdown avec frontmatter (name, description).
 *
 * Trois portées :
 *  - builtin : livrés avec Maestro (assets/skills), lecture seule ;
 *  - global  : <dataDir>/skills, partagés par tous les agents ;
 *  - agent   : <workspace>/.maestro/skills, propres à un agent.
 *
 * Chaque skill est aussi matérialisé au format natif Claude Code
 * (<workspace>/.claude/skills/<slug>/SKILL.md) pour être découvert par le CLI.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentConfig, SkillDef, SkillScope } from '@maestro/shared';
import type { Bus } from './bus.ts';
import type { MaestroConfig } from './config.ts';
import { nowIso } from './util.ts';

interface ParsedSkill {
  name: string;
  description: string;
  content: string;
  /** Provenance d'une skill importée, conservée dans le frontmatter. */
  sourceUrl: string | null;
}

function parseFrontmatter(raw: string, fallbackName: string): ParsedSkill {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { name: fallbackName, description: '', content: raw.trim(), sourceUrl: null };
  const head = match[1] ?? '';
  const content = raw.slice(match[0].length).trim();
  const get = (key: string): string => {
    const m = head.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
  };
  return {
    name: get('name') || fallbackName,
    description: get('description'),
    content,
    sourceUrl: get('source') || null,
  };
}

function serializeSkill(
  name: string,
  description: string,
  content: string,
  sourceUrl?: string | null,
): string {
  const source = sourceUrl ? `source: ${sourceUrl}\n` : '';
  return `---\nname: ${name}\ndescription: ${description}\n${source}---\n\n${content.trim()}\n`;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export class SkillRegistry {
  constructor(
    private config: MaestroConfig,
    private bus: Bus,
    private listAgents: () => AgentConfig[],
  ) {}

  private agentSkillsDir(agent: AgentConfig): string {
    return join(agent.workspaceDir, '.maestro', 'skills');
  }

  private scanDir(dir: string, scope: SkillScope, agentId: string | null): SkillDef[] {
    if (!existsSync(dir)) return [];
    const out: SkillDef[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const slug = file.replace(/\.md$/, '');
      const filePath = join(dir, file);
      try {
        const parsed = parseFrontmatter(readFileSync(filePath, 'utf8'), slug);
        out.push({
          id: agentId ? `agent:${agentId}:${slug}` : `${scope}:${slug}`,
          slug,
          scope,
          agentId,
          name: parsed.name,
          description: parsed.description,
          content: parsed.content,
          sourceUrl: parsed.sourceUrl,
          filePath,
          updatedAt: nowIso(),
        });
      } catch {
        // Fichier illisible : ignoré, ne bloque jamais le scan.
      }
    }
    return out;
  }

  /**
   * Skills Claude Code natives : un dossier par skill contenant SKILL.md
   * (~/.claude/skills, lien vers claude-index). Lecture seule, et surtout
   * jamais recopiées — le CLI les charge déjà. Maestro ne fait que les référencer
   * pour qu'elles soient sélectionnables au lancement d'un run.
   */
  private scanNativeDir(dir: string): SkillDef[] {
    if (!existsSync(dir)) return [];
    const out: SkillDef[] = [];
    for (const entry of readdirSync(dir)) {
      const filePath = join(dir, entry, 'SKILL.md');
      if (!existsSync(filePath)) continue;
      try {
        const parsed = parseFrontmatter(readFileSync(filePath, 'utf8'), entry);
        out.push({
          id: `native:${entry}`,
          slug: entry,
          scope: 'native',
          agentId: null,
          name: parsed.name,
          description: parsed.description,
          content: parsed.content,
          sourceUrl: parsed.sourceUrl,
          filePath,
          updatedAt: nowIso(),
        });
      } catch {
        // Skill illisible : ignorée, ne bloque jamais le scan.
      }
    }
    return out;
  }

  list(): SkillDef[] {
    const skills: SkillDef[] = [
      ...this.scanDir(this.config.builtinSkillsDir, 'builtin', null),
      ...this.scanNativeDir(this.config.nativeSkillsDir),
      ...this.scanDir(this.config.globalSkillsDir, 'global', null),
    ];
    for (const agent of this.listAgents()) {
      skills.push(...this.scanDir(this.agentSkillsDir(agent), 'agent', agent.id));
    }
    return skills;
  }

  get(id: string): SkillDef | null {
    return this.list().find((s) => s.id === id) ?? null;
  }

  upsert(input: {
    scope: SkillScope;
    agentId?: string | null;
    slug: string;
    name: string;
    description: string;
    content: string;
    sourceUrl?: string | null;
  }): SkillDef {
    if (input.scope === 'builtin' || input.scope === 'native') {
      throw new Error(`Les skills « ${input.scope} » sont en lecture seule`);
    }
    const slug = slugify(input.slug || input.name);
    if (!slug) throw new Error('Slug invalide');

    let dir: string;
    let agentId: string | null = null;
    if (input.scope === 'agent') {
      const agent = this.listAgents().find((a) => a.id === input.agentId);
      if (!agent) throw new Error(`Agent introuvable : ${input.agentId}`);
      dir = this.agentSkillsDir(agent);
      agentId = agent.id;
    } else {
      dir = this.config.globalSkillsDir;
    }
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${slug}.md`);
    writeFileSync(
      filePath,
      serializeSkill(input.name, input.description, input.content, input.sourceUrl ?? null),
    );
    this.syncAllWorkspaces();
    this.publishChange();
    this.bus.log('success', 'skills', `Skill « ${input.name} » enregistré (${input.scope})`);
    return {
      id: agentId ? `agent:${agentId}:${slug}` : `${input.scope}:${slug}`,
      slug,
      scope: input.scope,
      agentId,
      name: input.name,
      description: input.description,
      content: input.content.trim(),
      sourceUrl: input.sourceUrl ?? null,
      filePath,
      updatedAt: nowIso(),
    };
  }

  remove(id: string): boolean {
    const skill = this.get(id);
    if (!skill) return false;
    if (skill.scope === 'builtin' || skill.scope === 'native') {
      throw new Error(`Les skills « ${skill.scope} » sont en lecture seule`);
    }
    rmSync(skill.filePath, { force: true });
    this.syncAllWorkspaces();
    this.publishChange();
    this.bus.log('warn', 'skills', `Skill « ${skill.name} » supprimé`);
    return true;
  }

  /**
   * Préambule injecté dans le prompt d'un run quand une skill est sélectionnée.
   *
   * Pour une skill native, on la désigne par son nom au lieu d'en recopier le
   * corps : le CLI la charge lui-même, dans sa version courante, et le contexte
   * n'est pas payé deux fois.
   */
  promptPreamble(skillId: string): string | null {
    const skill = this.get(skillId);
    if (!skill) return null;
    if (skill.scope === 'native') {
      return (
        `Applique la skill \`${skill.slug}\` (${skill.name}) — charge-la avant de commencer.\n\n` +
        `---\n\nDemande :\n`
      );
    }
    return `# Skill : ${skill.name}\n\n${skill.content}\n\n---\n\nDemande :\n`;
  }

  /**
   * Matérialise les skills applicables au format natif Claude Code dans le
   * workspace de chaque agent : .claude/skills/<slug>/SKILL.md.
   */
  syncAgentWorkspace(agent: AgentConfig): void {
    const targetRoot = join(agent.workspaceDir, '.claude', 'skills');
    mkdirSync(targetRoot, { recursive: true });
    const applicable = this.list().filter(
      (s) => s.scope !== 'native' && (s.scope !== 'agent' || s.agentId === agent.id),
    );
    const keep = new Set(applicable.map((s) => s.slug));
    // Purge des skills retirés.
    if (existsSync(targetRoot)) {
      for (const entry of readdirSync(targetRoot)) {
        if (!keep.has(entry)) rmSync(join(targetRoot, entry), { recursive: true, force: true });
      }
    }
    for (const skill of applicable) {
      const dir = join(targetRoot, skill.slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'SKILL.md'),
        serializeSkill(skill.name, skill.description, skill.content, skill.sourceUrl),
      );
    }
  }

  syncAllWorkspaces(): void {
    for (const agent of this.listAgents()) {
      try {
        this.syncAgentWorkspace(agent);
      } catch (err) {
        this.bus.log('warn', 'skills', `Sync workspace ${agent.name} impossible : ${String(err)}`, {
          agentId: agent.id,
        });
      }
    }
  }

  private publishChange(): void {
    this.bus.publish({ type: 'skill.changed', payload: { skills: this.list() } });
  }
}
