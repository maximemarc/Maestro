/**
 * Exposition Prometheus.
 *
 * `/api/health` ne rendait qu'un booléen : une instance dont la file d'attente
 * grossit sans fin, dont les approbations s'empilent ou dont le coût du jour
 * s'emballe reste « ok » jusqu'à ce que quelqu'un ouvre l'interface. Un format
 * que les superviseurs savent déjà lire coûte trente lignes et rend l'instance
 * surveillable.
 *
 * Format texte 0.0.4, écrit à la main : une bibliothèque de métriques
 * apporterait un registre, des histogrammes et des labels dont rien ici n'a
 * l'usage — on expose une douzaine de jauges.
 */
import type { MetricsSnapshot } from '@maestro/shared';

/** Une métrique, avec ce qu'attend Prometheus pour la documenter. */
interface Gauge {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  value: number;
}

/**
 * Échappe une aide.
 *
 * Un saut de ligne ou une barre oblique inverse non échappés cassent l'analyse
 * du format, et l'erreur se manifeste chez le collecteur, pas ici.
 */
function escapeHelp(help: string): string {
  return help.replaceAll('\\', '\\\\').replaceAll('\n', ' ');
}

export function renderPrometheus(
  snapshot: MetricsSnapshot,
  extra: { databaseBytes: number; agents: number; runsTotal: number },
): string {
  const gauges: Gauge[] = [
    {
      name: 'maestro_uptime_seconds',
      help: 'Temps depuis le démarrage du serveur.',
      type: 'gauge',
      value: snapshot.uptimeSec,
    },
    {
      name: 'maestro_runs_active',
      help: 'Runs en cours d’exécution.',
      type: 'gauge',
      value: snapshot.activeRuns,
    },
    {
      name: 'maestro_runs_queued',
      help: 'Runs en file d’attente. Une croissance continue signale une saturation.',
      type: 'gauge',
      value: snapshot.queuedRuns,
    },
    {
      name: 'maestro_approvals_pending',
      help: 'Approbations en attente. Chacune bloque le run qui l’a demandée.',
      type: 'gauge',
      value: snapshot.pendingApprovals,
    },
    {
      name: 'maestro_events_per_second',
      help: 'Débit d’événements sur la fenêtre glissante.',
      type: 'gauge',
      value: snapshot.eventsPerSec,
    },
    {
      name: 'maestro_tokens_today',
      help: 'Tokens consommés depuis le début de la journée, entrée et sortie confondues.',
      type: 'gauge',
      value: snapshot.todayInputTokens + snapshot.todayOutputTokens,
    },
    {
      name: 'maestro_cost_usd_today',
      help: 'Coût du jour en dollars.',
      type: 'gauge',
      value: snapshot.todayCostUsd,
    },
    {
      name: 'maestro_clients_connected',
      help: 'Interfaces connectées au flux temps réel.',
      type: 'gauge',
      value: snapshot.connectedClients,
    },
    {
      name: 'maestro_agents_total',
      help: 'Agents non archivés.',
      type: 'gauge',
      value: extra.agents,
    },
    {
      name: 'maestro_runs_total',
      help: 'Runs enregistrés dans la base.',
      type: 'gauge',
      value: extra.runsTotal,
    },
    {
      name: 'maestro_database_bytes',
      help: 'Taille de la base. Sans rétention configurée, elle ne décroît jamais.',
      type: 'gauge',
      value: extra.databaseBytes,
    },
  ];

  const lines: string[] = [];
  for (const gauge of gauges) {
    lines.push(`# HELP ${gauge.name} ${escapeHelp(gauge.help)}`);
    lines.push(`# TYPE ${gauge.name} ${gauge.type}`);
    // Les valeurs non finies (division par zéro amont) casseraient le collecteur.
    lines.push(`${gauge.name} ${Number.isFinite(gauge.value) ? gauge.value : 0}`);
  }
  // Le format exige un saut de ligne final.
  return `${lines.join('\n')}\n`;
}
