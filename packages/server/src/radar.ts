/**
 * Radar de sessions : détecte les agents de code actifs sur la machine, qu'ils
 * soient pilotés par Maestro ou lancés à la main dans un terminal.
 *
 * Deux sources, délibérément asymétriques :
 *
 *  - **Transcripts** — source de vérité pour Claude Code. Un vrai tour de session
 *    écrit une ligne JSONL dans ~/.claude/projects/<cwd encodé>/<sessionId>.jsonl,
 *    ce que ne font ni les serveurs MCP ni les processus auxiliaires. Partir de là
 *    évite de compter des sidecars comme des sessions, ce qu'un simple `ps` sur
 *    « claude » ferait immanquablement.
 *  - **Processus** — pour les autres outils (Codex, Gemini, Aider…), dont le
 *    binaire est distinctif, et pour enrichir une session Claude Code déjà
 *    détectée (pid, charge CPU, ancienneté).
 *
 * 🔒 Seules des métadonnées sont lues dans un transcript : cwd, identifiant de
 * session, version, branche git, horodatage. Jamais le contenu des messages.
 */
import { execFile } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  statSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type {
  AgentToolKind,
  DetectedSession,
  DetectionSource,
  RadarSnapshot,
  SessionFreshness,
} from '@maestro/shared';
import type { AgentService } from './agents.ts';
import type { Bus } from './bus.ts';
import type { MaestroConfig } from './config.ts';
import type { Store } from './db.ts';
import { nowIso } from './util.ts';

const exec = promisify(execFile);

/** Au-delà, une session n'est plus montrée : elle est considérée terminée. */
const HORIZON_MS = 3 * 60 * 60 * 1000;
const ACTIVE_MS = 2 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;
/** Queue de fichier suffisante pour retrouver la dernière ligne JSONL complète. */
const TAIL_BYTES = 64 * 1024;

interface ToolMatcher {
  kind: AgentToolKind;
  label: string;
  /** Commande à chercher dans le PATH pour signaler l'outil comme installé. */
  binary: string;
  /** Reconnaît la ligne de commande d'une session (pas d'un auxiliaire). */
  matches: (args: string) => boolean;
}

/**
 * Les motifs visent la commande de session, pas ses satellites. « claude » est
 * volontairement absent : ses sessions passent par les transcripts, et son nom
 * apparaît dans trop de processus annexes (serveurs MCP, ponts, sidecars).
 */
const TOOL_MATCHERS: ToolMatcher[] = [
  {
    kind: 'codex',
    label: 'Codex',
    binary: 'codex',
    matches: (a) => /(^|\/)codex(\s|$)/.test(a) && !/mcp|--server/.test(a),
  },
  {
    kind: 'gemini',
    label: 'Gemini CLI',
    binary: 'gemini',
    matches: (a) => /(^|\/)gemini(\s|$)/.test(a),
  },
  { kind: 'aider', label: 'Aider', binary: 'aider', matches: (a) => /(^|\/)aider(\s|$)/.test(a) },
  {
    kind: 'cursor',
    label: 'Cursor Agent',
    binary: 'cursor-agent',
    matches: (a) => /(^|\/)cursor-agent(\s|$)/.test(a),
  },
  {
    kind: 'opencode',
    label: 'OpenCode',
    binary: 'opencode',
    matches: (a) => /(^|\/)opencode(\s|$)/.test(a),
  },
  { kind: 'goose', label: 'Goose', binary: 'goose', matches: (a) => /(^|\/)goose(\s|$)/.test(a) },
];

interface TranscriptMeta {
  sessionId: string | null;
  cwd: string | null;
  version: string | null;
  gitBranch: string | null;
  entrypoint: string | null;
  isSidechain: boolean;
  timestamp: string | null;
}

interface ProcessInfo {
  pid: number;
  uptimeSec: number;
  cpuPercent: number;
  args: string;
  cwd: string | null;
}

function freshnessOf(lastActivityMs: number | null, busy: boolean): SessionFreshness {
  if (busy) return 'active';
  if (lastActivityMs === null) return 'stale';
  const age = Date.now() - lastActivityMs;
  if (age <= ACTIVE_MS) return 'active';
  if (age <= IDLE_MS) return 'idle';
  return 'stale';
}

export class SessionRadar {
  private timer: NodeJS.Timeout | null = null;
  private lastSnapshot: RadarSnapshot;
  private installed: AgentToolKind[] | null = null;

  constructor(
    private config: MaestroConfig,
    private store: Store,
    private bus: Bus,
    private agents: AgentService,
  ) {
    this.lastSnapshot = {
      scannedAt: nowIso(),
      scanDurationMs: 0,
      sessions: [],
      toolsInstalled: [],
      enabled: false,
    };
  }

  snapshot(): RadarSnapshot {
    return this.lastSnapshot;
  }

  start(intervalMs = 10_000): void {
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Un balayage complet, diffusé sur le bus. */
  async sweep(): Promise<RadarSnapshot> {
    const startedAt = Date.now();
    let sessions: DetectedSession[] = [];
    try {
      const processes = await this.scanProcesses();
      sessions = [
        ...this.scanClaudeTranscripts(processes),
        ...this.sessionsFromProcesses(processes),
      ];
    } catch (err) {
      this.bus.log('warn', 'radar', `Balayage interrompu : ${String(err)}`);
    }

    // Les plus fraîches d'abord : c'est ce qu'on veut voir en premier.
    const order: Record<SessionFreshness, number> = { active: 0, idle: 1, stale: 2 };
    sessions.sort(
      (a, b) =>
        order[a.freshness] - order[b.freshness] ||
        (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''),
    );

    this.lastSnapshot = {
      scannedAt: nowIso(),
      scanDurationMs: Date.now() - startedAt,
      sessions,
      toolsInstalled: await this.detectInstalledTools(),
      enabled: this.timer !== null,
    };
    this.bus.publish({ type: 'radar.update', payload: this.lastSnapshot });
    return this.lastSnapshot;
  }

  // -- Transcripts Claude Code ---------------------------------------------------

  /**
   * Métadonnées d'un transcript, lues sans charger tout le fichier.
   *
   * On remonte les lignes depuis la fin en fusionnant les champs : la dernière
   * ligne est souvent un résumé ou un événement qui ne porte ni cwd ni version,
   * alors qu'une ligne un peu plus haut les contient. Se limiter à la dernière
   * donnerait des sessions sans projet ni version identifiables.
   */
  private readTranscriptMeta(path: string): TranscriptMeta | null {
    let fd: number | null = null;
    try {
      fd = openSync(path, 'r');
      const size = fstatSync(fd).size;
      if (size === 0) return null;
      const length = Math.min(TAIL_BYTES, size);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const lines = buffer
        .toString('utf8')
        .split('\n')
        .filter((l) => l.trim() !== '');
      const meta: TranscriptMeta = {
        sessionId: null,
        cwd: null,
        version: null,
        gitBranch: null,
        entrypoint: null,
        isSidechain: false,
        timestamp: null,
      };
      let seen = 0;
      for (let i = lines.length - 1; i >= 0 && seen < 40; i--) {
        const line = lines[i];
        if (!line || !line.startsWith('{')) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue; // ligne tronquée en début de fenêtre : on remonte encore
        }
        seen++;
        const str = (key: string): string | null =>
          typeof parsed[key] === 'string' && parsed[key] !== '' ? (parsed[key] as string) : null;
        meta.sessionId ??= str('sessionId');
        meta.cwd ??= str('cwd');
        meta.version ??= str('version');
        meta.gitBranch ??= str('gitBranch');
        meta.entrypoint ??= str('entrypoint');
        // L'horodatage doit rester celui de l'événement le plus récent.
        meta.timestamp ??= str('timestamp');
        if (parsed.isSidechain === true) meta.isSidechain = true;
        if (meta.sessionId && meta.cwd && meta.version && meta.timestamp) break;
      }
      return meta.sessionId || meta.cwd ? meta : null;
    } catch {
      return null;
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }

  private scanClaudeTranscripts(processes: ProcessInfo[]): DetectedSession[] {
    const root = this.config.claudeProjectsDir;
    if (!existsSync(root)) return [];
    const out: DetectedSession[] = [];
    const cutoff = Date.now() - HORIZON_MS;

    let projectDirs: string[];
    try {
      projectDirs = readdirSync(root);
    } catch {
      return [];
    }

    for (const projectDir of projectDirs) {
      const dir = join(root, projectDir);
      let files: string[];
      try {
        if (!statSync(dir).isDirectory()) continue;
        files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const file of files) {
        const path = join(dir, file);
        let mtimeMs: number;
        try {
          mtimeMs = statSync(path).mtimeMs;
        } catch {
          continue;
        }
        if (mtimeMs < cutoff) continue;
        const meta = this.readTranscriptMeta(path);
        // Une sidechain est le journal d'un subagent, pas une session à part.
        if (!meta || meta.isSidechain) continue;
        // Sans répertoire de travail, l'entrée n'est rattachable à rien d'utile.
        if (!meta.cwd) continue;

        const sessionId = meta.sessionId ?? file.replace(/\.jsonl$/, '');
        const cwd = meta.cwd;
        const lastActivityMs = meta.timestamp ? Date.parse(meta.timestamp) : mtimeMs;
        const proc = cwd
          ? processes.find((p) => p.cwd === cwd && this.looksLikeClaude(p.args))
          : undefined;

        out.push({
          id: `claude-code:${sessionId}`,
          tool: 'claude-code',
          toolLabel: 'Claude Code',
          sessionId,
          cwd,
          project: cwd ? basename(cwd) : null,
          gitBranch: meta.gitBranch,
          version: meta.version,
          entrypoint: meta.entrypoint,
          pid: proc?.pid ?? null,
          cpuPercent: proc?.cpuPercent ?? null,
          uptimeSec: proc?.uptimeSec ?? null,
          lastActivityAt: new Date(lastActivityMs).toISOString(),
          freshness: freshnessOf(lastActivityMs, (proc?.cpuPercent ?? 0) > 20),
          sources: proc
            ? (['transcript', 'process'] as DetectionSource[])
            : (['transcript'] as DetectionSource[]),
          managed: cwd ? this.attributeToMaestro(cwd) : null,
        });
      }
    }
    return out;
  }

  /** Processus susceptible de porter une session Claude Code (hors auxiliaires). */
  private looksLikeClaude(args: string): boolean {
    if (/mcp-server|worker-service|\/remote\/srv\//.test(args)) return false;
    return /(^|\/)(claude|ccd-cli)(\s|$)|\/ccd-cli\//.test(args);
  }

  /**
   * Une session dont le cwd est un workspace d'agent est un run Maestro : on la
   * rattache, pour distinguer d'un coup d'œil le piloté du sauvage.
   */
  private attributeToMaestro(cwd: string): DetectedSession['managed'] {
    if (!cwd.startsWith(this.config.workspacesDir)) return null;
    const agent = this.agents
      .list(true)
      .find((a) => cwd === a.workspaceDir || cwd.startsWith(a.workspaceDir + '/'));
    if (!agent) return null;
    const activeRun = this.store.listActiveRuns().find((r) => r.agentId === agent.id);
    return {
      agentId: agent.id,
      agentName: agent.name,
      agentEmoji: agent.emoji,
      runId: activeRun?.id ?? null,
    };
  }

  // -- Processus ------------------------------------------------------------------

  private async scanProcesses(): Promise<ProcessInfo[]> {
    let stdout: string;
    try {
      ({ stdout } = await exec('ps', ['-eo', 'pid=,etimes=,pcpu=,args='], {
        maxBuffer: 4 * 1024 * 1024,
      }));
    } catch {
      return [];
    }
    const out: ProcessInfo[] = [];
    for (const line of stdout.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
      if (!match) continue;
      const [, pidRaw, etimesRaw, cpuRaw, args] = match;
      if (!pidRaw || !args) continue;
      const pid = Number(pidRaw);
      if (pid === process.pid) continue;
      out.push({
        pid,
        uptimeSec: Number(etimesRaw ?? 0),
        cpuPercent: Number(cpuRaw ?? 0),
        args,
        cwd: this.cwdOf(pid),
      });
    }
    return out;
  }

  /**
   * cwd d'un processus. /proc/<pid>/cwd est un lien symbolique — d'où readlink.
   * Échoue silencieusement pour un processus d'un autre utilisateur, ou hors Linux.
   */
  private cwdOf(pid: number): string | null {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }

  /** Sessions des outils autres que Claude Code, vues uniquement par leur processus. */
  private sessionsFromProcesses(processes: ProcessInfo[]): DetectedSession[] {
    const out: DetectedSession[] = [];
    for (const proc of processes) {
      const matcher = TOOL_MATCHERS.find((m) => m.matches(proc.args));
      if (!matcher) continue;
      const startedMs = Date.now() - proc.uptimeSec * 1000;
      out.push({
        id: `${matcher.kind}:${proc.pid}`,
        tool: matcher.kind,
        toolLabel: matcher.label,
        sessionId: null,
        cwd: proc.cwd,
        project: proc.cwd ? basename(proc.cwd) : null,
        gitBranch: null,
        version: null,
        entrypoint: null,
        pid: proc.pid,
        cpuPercent: proc.cpuPercent,
        uptimeSec: proc.uptimeSec,
        // Sans transcript, l'activité se déduit du processus lui-même.
        lastActivityAt: new Date(proc.cpuPercent > 1 ? Date.now() : startedMs).toISOString(),
        freshness: proc.cpuPercent > 20 ? 'active' : 'idle',
        sources: ['process'],
        managed: proc.cwd ? this.attributeToMaestro(proc.cwd) : null,
      });
    }
    return out;
  }

  /** Outils dont le binaire est présent — pour dire ce qui est surveillé. */
  private async detectInstalledTools(): Promise<AgentToolKind[]> {
    if (this.installed) return this.installed;
    const found: AgentToolKind[] = ['claude-code'];
    for (const matcher of TOOL_MATCHERS) {
      try {
        await exec('command', ['-v', matcher.binary], { shell: '/bin/sh' });
        found.push(matcher.kind);
      } catch {
        // Binaire absent : l'outil reste surveillé, il n'y a simplement rien à voir.
      }
    }
    this.installed = found;
    return found;
  }
}
