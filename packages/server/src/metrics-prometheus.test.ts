import { describe, expect, it } from 'vitest';
import type { MetricsSnapshot } from '@maestro/shared';
import { renderPrometheus } from './metrics-prometheus.ts';

const SNAPSHOT: MetricsSnapshot = {
  ts: '2026-08-28T12:00:00.000Z',
  uptimeSec: 3600,
  activeRuns: 2,
  queuedRuns: 5,
  pendingApprovals: 1,
  eventsPerSec: 3.5,
  todayInputTokens: 1000,
  todayOutputTokens: 250,
  todayCostUsd: 0.42,
  connectedClients: 1,
};

const EXTRA = { databaseBytes: 1024, agents: 18, runsTotal: 42 };

function metric(text: string, name: string): string | undefined {
  return text.split('\n').find((l) => l.startsWith(`${name} `));
}

describe('exposition Prometheus', () => {
  const text = renderPrometheus(SNAPSHOT, EXTRA);

  /*
   * Le format exige HELP et TYPE avant chaque valeur. Un collecteur qui ne les
   * trouve pas ignore la métrique sans le dire.
   */
  it('documente chaque métrique', () => {
    const names = [...text.matchAll(/^# HELP (\S+)/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(8);
    for (const name of names) {
      expect(text).toContain(`# TYPE ${name} `);
      expect(metric(text, name!)).toBeDefined();
    }
  });

  it('reporte les valeurs du snapshot', () => {
    expect(metric(text, 'maestro_runs_active')).toBe('maestro_runs_active 2');
    expect(metric(text, 'maestro_runs_queued')).toBe('maestro_runs_queued 5');
    expect(metric(text, 'maestro_approvals_pending')).toBe('maestro_approvals_pending 1');
    expect(metric(text, 'maestro_cost_usd_today')).toBe('maestro_cost_usd_today 0.42');
  });

  it('somme les tokens d’entrée et de sortie', () => {
    expect(metric(text, 'maestro_tokens_today')).toBe('maestro_tokens_today 1250');
  });

  it('expose la taille de la base et les comptages', () => {
    expect(metric(text, 'maestro_database_bytes')).toBe('maestro_database_bytes 1024');
    expect(metric(text, 'maestro_agents_total')).toBe('maestro_agents_total 18');
    expect(metric(text, 'maestro_runs_total')).toBe('maestro_runs_total 42');
  });

  /* Une valeur non finie casse le collecteur, pas Maestro : le défaut se
     manifesterait ailleurs, ce qui le rend pénible à rattacher. */
  it('remplace une valeur non finie par zéro', () => {
    const broken = renderPrometheus({ ...SNAPSHOT, eventsPerSec: Number.NaN }, EXTRA);
    expect(metric(broken, 'maestro_events_per_second')).toBe('maestro_events_per_second 0');
  });

  it('termine par un saut de ligne, comme l’exige le format', () => {
    expect(text.endsWith('\n')).toBe(true);
  });

  it('ne laisse aucun saut de ligne dans une aide', () => {
    for (const line of text.split('\n')) {
      if (!line.startsWith('# HELP')) continue;
      expect(line.split(' ').length).toBeGreaterThan(2);
    }
  });
});
