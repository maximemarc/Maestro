/**
 * Plugins Claude Code : clonage local, inventaire, mise à jour, désinstallation.
 *
 * Un plugin n'est pas un fichier mais un répertoire, chargé par session
 * (`--plugin-dir` côté CLI, `plugins: [{type:'local', path}]` côté SDK). Maestro
 * les clone sous <dataDir>/plugins/<slug> et ne touche jamais à l'état global du
 * CLI (~/.claude/plugins) : l'installation reste réversible et propre à Maestro.
 *
 * 🔒 Un plugin apporte du code exécutable (hooks) et des consignes (skills,
 * agents) : son installation est une décision humaine, jamais automatique, et
 * l'URL clonée est restreinte à GitHub.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentConfig, PluginInstall, PluginInventory } from '@maestro/shared';
import type { Bus } from './bus.ts';
import type { MaestroConfig } from './config.ts';
import type { Store } from './db.ts';
import { makeId, nowIso } from './util.ts';

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;

export class PluginError extends Error {}

const EMPTY_INVENTORY: PluginInventory = {
  skills: 0,
  agents: 0,
  commands: 0,
  hooks: 0,
  mcpServers: 0,
};

/** Compte les entrées d'un répertoire correspondant à un prédicat. */
function countIn(dir: string, predicate: (entry: string, full: string) => boolean): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((entry) => predicate(entry, join(dir, entry))).length;
  } catch {
    return 0;
  }
}

export class PluginService {
  constructor(
    private config: MaestroConfig,
    private store: Store,
    private bus: Bus,
  ) {}

  list(): PluginInstall[] {
    return this.store.listPlugins();
  }

  get(id: string): PluginInstall | null {
    return this.store.getPlugin(id);
  }

  /**
   * Chemins des plugins à charger pour un agent. Un plugin retiré du disque
   * entre-temps est ignoré : passer un chemin mort au CLI ferait échouer la session.
   */
  pathsForAgent(agent: AgentConfig): string[] {
    const paths: string[] = [];
    for (const id of agent.pluginIds ?? []) {
      const plugin = this.store.getPlugin(id);
      if (!plugin) continue;
      if (!existsSync(plugin.path)) {
        this.bus.log('warn', 'plugins', `Plugin « ${plugin.name} » absent du disque : ignoré`, {
          agentId: agent.id,
        });
        continue;
      }
      paths.push(plugin.path);
    }
    return paths;
  }

  /**
   * Inventaire réel, mesuré sur le disque après clonage — plus fiable que ce que
   * déclare le manifeste, qui n'énumère pas toujours ses composants.
   */
  scanInventory(dir: string): PluginInventory {
    const isMd = (entry: string) => entry.endsWith('.md');
    const skillsDir = join(dir, 'skills');
    return {
      // Une skill est un dossier contenant SKILL.md ; certains plugins la posent à plat.
      skills:
        countIn(skillsDir, (entry, full) => {
          try {
            return statSync(full).isDirectory() && existsSync(join(full, 'SKILL.md'));
          } catch {
            return false;
          }
        }) + countIn(skillsDir, (entry) => entry.endsWith('.md') && entry !== 'README.md'),
      agents: countIn(join(dir, 'agents'), isMd),
      commands: countIn(join(dir, 'commands'), isMd),
      hooks:
        countIn(join(dir, 'hooks'), (entry) => entry.endsWith('.sh') || entry.endsWith('.js')) +
        (existsSync(join(dir, 'hooks', 'hooks.json')) ? 1 : 0),
      mcpServers: existsSync(join(dir, '.mcp.json')) ? 1 : 0,
    };
  }

  /** Révision courante du clone, pour savoir ce qui tourne réellement. */
  private async revisionOf(dir: string): Promise<string | null> {
    try {
      const { stdout } = await exec('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
        timeout: GIT_TIMEOUT_MS,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Valide le plugin avec l'outil du CLI plutôt qu'avec notre propre lecture du
   * manifeste : c'est lui qui fait autorité sur le format.
   */
  private async validate(dir: string): Promise<string | null> {
    try {
      await exec('claude', ['plugin', 'validate', dir], { timeout: GIT_TIMEOUT_MS });
      return null;
    } catch (err) {
      const detail = err as { stdout?: string; stderr?: string; message?: string };
      return (detail.stdout || detail.stderr || detail.message || 'validation en échec').trim();
    }
  }

  async install(input: {
    slug: string;
    name: string;
    description: string;
    version: string | null;
    repo: string;
    cloneUrl: string;
    sourceUrl: string | null;
  }): Promise<PluginInstall> {
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/.test(input.cloneUrl)) {
      throw new PluginError(`URL de clonage refusée : ${input.cloneUrl}`);
    }
    const slug = input.slug
      .replace(/[^a-z0-9-]/gi, '-')
      .toLowerCase()
      .slice(0, 64);
    if (!slug) throw new PluginError('Slug de plugin invalide.');
    if (this.store.getPluginBySlug(slug)) {
      throw new PluginError(`Un plugin « ${slug} » est déjà installé.`);
    }

    const dir = join(this.config.pluginsDir, slug);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });

    try {
      await exec('git', ['clone', '--depth', '1', input.cloneUrl, dir], {
        timeout: GIT_TIMEOUT_MS,
      });
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      const detail = err as { stderr?: string; message?: string };
      throw new PluginError(
        `Clonage impossible : ${(detail.stderr || detail.message || '').trim()}`,
      );
    }

    const invalid = await this.validate(dir);
    if (invalid) {
      rmSync(dir, { recursive: true, force: true });
      throw new PluginError(`Le dépôt cloné n'est pas un plugin valide :\n${invalid}`);
    }

    const now = nowIso();
    const plugin: PluginInstall = {
      id: makeId('plg'),
      slug,
      name: input.name || slug,
      description: input.description,
      version: input.version,
      repo: input.repo,
      sourceUrl: input.sourceUrl,
      path: dir,
      revision: await this.revisionOf(dir),
      inventory: this.scanInventory(dir),
      installedAt: now,
      updatedAt: now,
    };
    this.store.insertPlugin(plugin);
    this.bus.log(
      'success',
      'plugins',
      `Plugin « ${plugin.name} » installé (${plugin.inventory.skills} skills, ` +
        `${plugin.inventory.agents} agents, ${plugin.inventory.commands} commandes)`,
    );
    return plugin;
  }

  async update(id: string): Promise<PluginInstall> {
    const plugin = this.store.getPlugin(id);
    if (!plugin) throw new PluginError('Plugin introuvable.');
    if (!existsSync(plugin.path)) throw new PluginError('Répertoire du plugin absent du disque.');
    try {
      // Un clone --depth 1 n'a pas d'historique : on refait un fetch superficiel.
      await exec('git', ['-C', plugin.path, 'fetch', '--depth', '1', 'origin', 'HEAD'], {
        timeout: GIT_TIMEOUT_MS,
      });
      await exec('git', ['-C', plugin.path, 'reset', '--hard', 'FETCH_HEAD'], {
        timeout: GIT_TIMEOUT_MS,
      });
    } catch (err) {
      const detail = err as { stderr?: string; message?: string };
      throw new PluginError(
        `Mise à jour impossible : ${(detail.stderr || detail.message || '').trim()}`,
      );
    }
    const updated: PluginInstall = {
      ...plugin,
      revision: await this.revisionOf(plugin.path),
      inventory: this.scanInventory(plugin.path),
      updatedAt: nowIso(),
    };
    this.store.updatePlugin(updated);
    this.bus.log('info', 'plugins', `Plugin « ${updated.name} » mis à jour (${updated.revision})`);
    return updated;
  }

  remove(id: string): boolean {
    const plugin = this.store.getPlugin(id);
    if (!plugin) return false;
    // Garde-fou : ne supprimer que dans le répertoire géré par Maestro.
    if (plugin.path.startsWith(this.config.pluginsDir)) {
      rmSync(plugin.path, { recursive: true, force: true });
    } else {
      this.bus.log('warn', 'plugins', `Chemin hors périmètre, non supprimé : ${plugin.path}`);
    }
    const detached = this.store.detachPluginFromAgents(id);
    this.store.deletePlugin(id);
    this.bus.log(
      'warn',
      'plugins',
      `Plugin « ${plugin.name} » désinstallé${detached > 0 ? ` (retiré de ${detached} agent(s))` : ''}`,
    );
    return true;
  }

  static emptyInventory(): PluginInventory {
    return { ...EMPTY_INVENTORY };
  }
}
