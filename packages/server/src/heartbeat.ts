/**
 * Battement de cœur : l'orchestrateur qui délibère.
 *
 * Une routine cron exécute un prompt écrit d'avance. Un battement dresse un
 * **état des lieux**, le confie à un agent avec ses consignes permanentes
 * (`HEARTBEAT.md`), et laisse cet agent décider s'il y a lieu d'agir. La
 * différence tient dans le dernier point : un cron agit toujours, un battement
 * peut conclure que tout va bien — et c'est un succès.
 *
 * ## Pourquoi aucune nouvelle surface d'action
 *
 * Un battement **est un run**. L'agent agit par les outils MCP qu'il a déjà :
 * kanban, délégation, mémoire. Rien de spécifique n'est ajouté, et c'est
 * délibéré : sa politique d'approbation et sa liste d'outils autorisés bornent
 * la délibération exactement comme elles bornent le reste. Un canal d'action
 * dédié au battement échapperait à ces garde-fous.
 *
 * ## Le mode d'échec principal, et sa parade
 *
 * Sans mémoire de ses propres décisions, un agent qui délibère toutes les heures
 * recrée la même carte kanban vingt-quatre fois par jour — il n'a aucun moyen de
 * savoir qu'il l'a déjà créée. Les comptes rendus des battements précédents sont
 * donc réinjectés dans l'état des lieux. C'est la pièce sans laquelle la
 * fonctionnalité serait activement nuisible.
 *
 * 🔒 Un orchestrateur qui délibère dépense des tokens sans que personne n'ait
 * rien demandé. Les garde-fous (`guardBeat`) ne sont pas des options : ils sont
 * la condition d'acceptabilité. Ils sont testés isolément, en fonction pure.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Cron } from 'croner';
import {
  HEARTBEAT_MIN_INTERVAL_SEC,
  KANBAN_COLUMNS,
  type AgentConfig,
  type Beat,
  type HeartbeatConfig,
  type SituationReport,
} from '@maestro/shared';
import type { AgentService } from './agents.ts';
import type { Bus } from './bus.ts';
import type { Store } from './db.ts';
import type { ProviderService } from './providers/registry.ts';
import type { RunEngine } from './runs.ts';
import { nowIso, truncate } from './util.ts';

/** Nombre de battements passés rappelés à l'agent. */
const MEMORY_DEPTH = 5;
/** Échecs récents détaillés dans l'état des lieux. */
const FAILURES_SHOWN = 5;

/** Consignes déposées dans le workspace de l'agent à la première activation. */
export const HEARTBEAT_TEMPLATE = `# Consignes permanentes du battement de cœur

Tu es appelé périodiquement avec un état des lieux de l'orchestrateur. Ton rôle
n'est pas d'agir à tout prix : c'est de **juger s'il y a lieu d'agir**.

## Ce qu'on attend de toi

1. Lis l'état des lieux, et surtout la section « battements précédents ».
2. Si rien ne le justifie, **ne fais rien** et dis-le. C'est la réponse la plus
   fréquente, et c'est une bonne réponse.
3. Sinon, agis par tes outils : crée une carte kanban, délègue à un agent,
   consigne un fait en mémoire.
4. Termine toujours par un compte rendu d'une ou deux phrases : ce que tu as
   fait, ou pourquoi tu n'as rien fait.

## Ce qu'il ne faut pas faire

- **Ne recrée pas ce que tu as déjà créé.** Les battements précédents te disent
  ce que tu as fait ; s'y reprendre serait du bruit.
- N'ouvre pas de chantier de fond de ta propre initiative : signale-le par une
  carte, et laisse un humain arbitrer.
- Ne touche pas à ce qu'un run en cours est en train de modifier.

## À surveiller en priorité

- Approbations en attente depuis longtemps : personne ne les a peut-être vues.
- Runs en échec répétés sur le même agent : il y a probablement une cause commune.
- Comptes de fournisseurs proches de leur limite d'usage.
`;

export interface HeartbeatDeps {
  store: Store;
  bus: Bus;
  agents: AgentService;
  engine: RunEngine;
  providers: ProviderService;
}

/** Décision d'un garde-fou : battre, ou sauter avec un motif. */
export type GuardVerdict = { beat: true } | { beat: false; reason: string };

export interface GuardInput {
  config: HeartbeatConfig;
  agent: AgentConfig | null;
  activeRuns: number;
  beatsToday: number;
  /** Vrai si un battement précédent n'a pas encore rendu la main. */
  previousStillRunning: boolean;
  /** Vrai si le compte du fournisseur approche de sa limite. */
  underQuotaPressure: boolean;
}

/**
 * Applique les garde-fous, dans un ordre qui n'est pas indifférent.
 *
 * Du moins coûteux au plus coûteux à évaluer, et surtout : la configuration
 * avant l'état du système. Un battement désactivé ne doit pas faire interroger
 * la base ni mesurer un quota.
 */
export function guardBeat(input: GuardInput): GuardVerdict {
  const { config } = input;
  if (!config.enabled) return { beat: false, reason: 'battement désactivé' };
  if (!config.agentId || !input.agent) {
    return { beat: false, reason: 'aucun agent de délibération configuré' };
  }
  if (input.agent.archived) {
    return { beat: false, reason: `l'agent « ${input.agent.name} » est archivé` };
  }
  if (input.beatsToday >= config.dailyMax) {
    return { beat: false, reason: `plafond quotidien atteint (${config.dailyMax} battements)` };
  }
  /* Un battement précédent encore en vol : le suivant jugerait un état que le
     premier est en train de changer, et les deux pourraient décider la même
     action. */
  if (input.previousStillRunning) {
    return { beat: false, reason: 'le battement précédent n’a pas terminé' };
  }
  if (config.skipWhenBusy && input.activeRuns > 0) {
    return { beat: false, reason: `${input.activeRuns} run(s) en cours` };
  }
  if (config.skipUnderQuotaPressure && input.underQuotaPressure) {
    /* Le travail demandé par un humain passe avant la délibération spontanée :
       consommer la fin d'un quota pour un battement serait le pire arbitrage. */
    return { beat: false, reason: 'compte proche de sa limite d’usage' };
  }
  return { beat: true };
}

/** Une expression cron que croner sait interpréter. */
export function validCron(cronExpr: string): boolean {
  try {
    new Cron(cronExpr, { paused: true }).stop();
    return true;
  } catch {
    return false;
  }
}

/**
 * Vérifie qu'un rythme respecte le plancher.
 *
 * Deux prochaines occurrences suffisent à mesurer l'intervalle, et c'est la
 * seule façon fiable de le faire : une expression cron n'a pas de période, elle
 * a des instants.
 */
export function intervalTooShort(cronExpr: string): boolean {
  try {
    const job = new Cron(cronExpr, { paused: true });
    const runs = job.nextRuns(2);
    job.stop();
    if (runs.length < 2) return false;
    const deltaSec = (runs[1]!.getTime() - runs[0]!.getTime()) / 1000;
    return deltaSec < HEARTBEAT_MIN_INTERVAL_SEC;
  } catch {
    /* Expression invalide : ce n'est pas le rôle de cette fonction de le dire,
       la validation cron s'en charge et rendra un message précis. */
    return false;
  }
}

/**
 * Met l'état des lieux en texte.
 *
 * Fonction pure, et séparée de l'assemblage : c'est ce que l'agent lit, donc ce
 * qui décide de la qualité de sa délibération. Un état des lieux verbeux noie
 * le signal ; un état des lieux muet fait délibérer à l'aveugle.
 */
export function renderReport(report: SituationReport): string {
  const lines: string[] = ['# État des lieux', '', `Relevé à ${report.at}.`, ''];

  lines.push('## Activité');
  lines.push(`- runs actifs : ${report.activeRuns}`);
  lines.push(`- runs en file : ${report.queuedRuns}`);
  lines.push(`- approbations en attente : ${report.pendingApprovals}`);
  lines.push('');

  const tasks = Object.entries(report.tasksByColumn)
    .map(([column, count]) => `${column} ${count}`)
    .join(' · ');
  lines.push('## Kanban');
  lines.push(tasks || '(aucune carte)');
  lines.push('');

  lines.push('## Échecs depuis le dernier battement');
  if (report.recentFailures.length === 0) lines.push('aucun');
  else {
    for (const failure of report.recentFailures) {
      lines.push(`- ${failure.agentName} (${failure.runId}) : ${failure.error}`);
    }
  }
  lines.push('');

  if (report.pressuredAccounts.length > 0) {
    lines.push('## Comptes proches de leur limite');
    for (const account of report.pressuredAccounts) {
      lines.push(`- ${account.name} : ${account.pressurePct} % de la fenêtre`);
    }
    lines.push('');
  }

  /* La section décisive : sans elle, l'agent refait chaque heure ce qu'il a
     déjà fait, faute de pouvoir s'en souvenir. */
  lines.push('## Battements précédents');
  if (report.previousBeats.length === 0) lines.push('aucun — c’est le premier.');
  else {
    for (const beat of report.previousBeats) {
      const label =
        beat.outcome === 'acted'
          ? 'a agi'
          : beat.outcome === 'idle'
            ? 'rien à faire'
            : beat.outcome === 'skipped'
              ? 'sauté'
              : 'échec';
      lines.push(`- ${beat.at} — ${label}${beat.summary ? ` : ${beat.summary}` : ''}`);
    }
  }

  return lines.join('\n');
}

export class HeartbeatService {
  private job: Cron | null = null;
  /** Run de délibération en vol, pour ne pas en lancer un second. */
  private inFlightRunId: string | null = null;

  constructor(private deps: HeartbeatDeps) {}

  config(): HeartbeatConfig {
    return this.deps.store.getHeartbeatConfig();
  }

  beats(limit = 20): Beat[] {
    return this.deps.store.listBeats(limit);
  }

  /** (Re)programme le battement selon la configuration enregistrée. */
  start(): void {
    this.job?.stop();
    this.job = null;
    const config = this.config();
    if (!config.enabled) return;
    try {
      this.job = new Cron(config.cronExpr, () => void this.beat(false));
      this.deps.bus.log('success', 'heartbeat', `Battement de cœur actif (${config.cronExpr})`);
    } catch (err) {
      this.deps.bus.log('error', 'heartbeat', `Rythme invalide : ${String(err)}`);
    }
  }

  stop(): void {
    this.job?.stop();
    this.job = null;
  }

  nextBeatAt(): string | null {
    const next = this.job?.nextRun();
    return next ? next.toISOString() : null;
  }

  update(patch: Partial<HeartbeatConfig>): HeartbeatConfig {
    if (patch.cronExpr !== undefined) {
      /* Validation ici et non dans la route, comme pour les routines : le
         service est le seul endroit qui connaisse ses propres règles, et une
         route qui les dupliquerait finirait par en oublier une. */
      if (!validCron(patch.cronExpr)) {
        throw new Error(`Expression cron invalide : ${patch.cronExpr}`);
      }
      if (intervalTooShort(patch.cronExpr)) {
        throw new Error(
          `Rythme trop rapproché : ${HEARTBEAT_MIN_INTERVAL_SEC / 60} minutes au minimum entre deux battements. ` +
            `Délibérer plus souvent coûterait plus que ça ne rapporte.`,
        );
      }
    }
    const config = this.deps.store.patchHeartbeatConfig(patch);
    /* Reprogrammer maintenant, pas au prochain démarrage : un rythme changé
       dans l'interface doit prendre effet tout de suite. */
    this.start();
    return config;
  }

  /**
   * Assemble l'état des lieux.
   *
   * Ce qui y figure est choisi : ce sur quoi un agent peut réellement agir. Les
   * métriques de tokens, par exemple, n'y sont pas — elles n'appellent aucune
   * décision de sa part, et occuperaient du contexte.
   */
  situation(): SituationReport {
    const { store, engine, agents, providers } = this.deps;
    const previous = store.listBeats(MEMORY_DEPTH);
    const since = previous[0]?.at ?? null;

    const tasksByColumn: Record<string, number> = {};
    for (const column of KANBAN_COLUMNS) tasksByColumn[column] = 0;
    for (const task of store.listTasks()) {
      tasksByColumn[task.column] = (tasksByColumn[task.column] ?? 0) + 1;
    }

    const failures = store
      .listRuns({ limit: 60 })
      .filter((run) => run.endedAt && run.status !== 'succeeded' && run.status !== 'cancelled')
      .filter((run) => (since ? run.endedAt! > since : true))
      .slice(0, FAILURES_SHOWN)
      .map((run) => ({
        runId: run.id,
        agentName: agents.get(run.agentId)?.name ?? run.agentId,
        error: truncate(run.error ?? 'sans message', 200),
      }));

    const pressured = providers
      .usageAll()
      .filter((usage) => usage.pressure !== null && usage.pressure >= 0.7)
      .map((usage) => ({
        name: providers.getAccount(usage.accountId)?.name ?? usage.accountId,
        pressurePct: Math.round((usage.pressure ?? 0) * 100),
      }));

    return {
      at: nowIso(),
      activeRuns: engine.activeCount(),
      queuedRuns: engine.queuedCount(),
      pendingApprovals: store.countPendingApprovals(),
      tasksByColumn,
      recentFailures: failures,
      pressuredAccounts: pressured,
      previousBeats: previous.map((b) => ({
        at: b.at,
        outcome: b.outcome,
        summary: b.summary,
      })),
    };
  }

  /**
   * Consignes permanentes de l'agent, créées au besoin.
   *
   * Dans le workspace de l'agent, à côté de son CLAUDE.md et de son MEMORY.md :
   * c'est là que l'opérateur s'attend à les trouver, et c'est ce qui rend la
   * délibération réglable sans toucher au code.
   */
  instructions(agent: AgentConfig): string {
    const path = join(agent.workspaceDir, 'HEARTBEAT.md');
    try {
      if (!existsSync(path)) {
        writeFileSync(path, HEARTBEAT_TEMPLATE, 'utf8');
        return HEARTBEAT_TEMPLATE;
      }
      return readFileSync(path, 'utf8');
    } catch (err) {
      this.deps.bus.log(
        'warn',
        'heartbeat',
        `Consignes illisibles pour « ${agent.name} » : ${err instanceof Error ? err.message : String(err)}`,
      );
      return HEARTBEAT_TEMPLATE;
    }
  }

  /**
   * Un battement.
   *
   * `manual` force l'évaluation mais **pas** les garde-fous : un bouton « battre
   * maintenant » qui les ignorerait permettrait de contourner le plafond
   * quotidien à la souris.
   */
  async beat(manual: boolean): Promise<Beat> {
    const { store, bus, agents, engine, providers } = this.deps;
    const config = this.config();
    const agent = config.agentId ? agents.get(config.agentId) : null;

    const dayStart = `${nowIso().slice(0, 10)}T00:00:00.000Z`;
    const previousRun = this.inFlightRunId ? store.getRun(this.inFlightRunId) : null;

    let underPressure = false;
    if (config.skipUnderQuotaPressure && agent) {
      const policy = providers.effectivePolicy(agent);
      underPressure = policy ? providers.underPressure(policy).size > 0 : false;
    }

    const verdict = guardBeat({
      config,
      agent,
      activeRuns: engine.activeCount(),
      beatsToday: store.countBeatsSince(dayStart),
      previousStillRunning: Boolean(previousRun && !previousRun.endedAt),
      underQuotaPressure: underPressure,
    });

    if (!verdict.beat) {
      const beat = store.insertBeat({
        at: nowIso(),
        outcome: 'skipped',
        reason: verdict.reason,
        runId: null,
        summary: null,
      });
      bus.publish({ type: 'heartbeat.beat', payload: beat });
      /* Journalisé en `info` et non en `warn` : sauter est le comportement
         normal et fréquent, pas une anomalie. */
      bus.log('info', 'heartbeat', `Battement sauté — ${verdict.reason}`);
      return beat;
    }

    const prompt = [
      this.instructions(agent!),
      '',
      '---',
      '',
      renderReport(this.situation()),
      '',
      '---',
      '',
      'Décide maintenant. Si rien ne justifie d’agir, dis-le et arrête-toi là.',
    ].join('\n');

    try {
      const run = engine.start({
        agentId: agent!.id,
        prompt,
        origin: 'heartbeat',
        originId: null,
      });
      this.inFlightRunId = run.id;
      const beat = store.insertBeat({
        at: nowIso(),
        outcome: 'acted',
        reason: manual ? 'déclenché à la main' : null,
        runId: run.id,
        summary: null,
      });
      bus.publish({ type: 'heartbeat.beat', payload: beat });
      bus.log('info', 'heartbeat', `Battement — délibération confiée à « ${agent!.name} »`, {
        agentId: agent!.id,
        runId: run.id,
      });
      this.watch(beat, run.id);
      return beat;
    } catch (err) {
      const beat = store.insertBeat({
        at: nowIso(),
        outcome: 'failed',
        reason: err instanceof Error ? err.message : String(err),
        runId: null,
        summary: null,
      });
      bus.publish({ type: 'heartbeat.beat', payload: beat });
      bus.log('error', 'heartbeat', `Battement en échec : ${beat.reason}`);
      return beat;
    }
  }

  /**
   * Attend la fin de la délibération pour en consigner l'issue.
   *
   * Sans cela, l'issue resterait « a agi » même quand l'agent a conclu qu'il
   * n'y avait rien à faire — et l'historique, comme la mémoire réinjectée au
   * battement suivant, mentirait sur ce qui s'est passé.
   */
  private watch(beat: Beat, runId: string): void {
    const HOUR = 60 * 60 * 1000;
    void this.deps.engine.waitForRun(runId, HOUR).then((finished) => {
      if (this.inFlightRunId === runId) this.inFlightRunId = null;
      if (!finished) return;
      const summary = finished.resultText ? truncate(finished.resultText, 400) : null;
      /* « rien à faire » est un succès, et doit se distinguer d'une action :
         c'est ce qui permet de voir si la délibération sert à quelque chose. */
      const outcome =
        finished.status !== 'succeeded' ? 'failed' : looksIdle(summary) ? 'idle' : 'acted';
      this.deps.store.completeBeat(beat.id, outcome, summary);
      this.deps.bus.publish({
        type: 'heartbeat.beat',
        payload: { ...beat, outcome, summary },
      });
    });
  }
}

/**
 * Reconnaît un compte rendu d'inaction.
 *
 * Heuristique volontairement étroite, et faillible : elle ne sert qu'à
 * l'affichage et à la mémoire du battement suivant, jamais à décider quoi que
 * ce soit. En cas de doute, le battement est compté comme ayant agi — surestimer
 * l'activité est moins trompeur que de la masquer.
 */
export function looksIdle(summary: string | null): boolean {
  if (!summary) return false;
  const normalised = summary
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return [
    'rien a faire',
    'rien a signaler',
    'aucune action',
    'pas d action',
    'rien ne justifie',
    'aucune intervention',
    'nothing to do',
    'no action',
  ].some((marker) => normalised.includes(marker));
}
