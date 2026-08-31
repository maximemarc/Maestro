import { describe, expect, it } from 'vitest';
import type { AgentSandbox } from '@maestro/shared';
import {
  DEFAULT_SANDBOX,
  alwaysProtected,
  buildSandboxSettings,
  describeSandbox,
} from './sandbox.ts';

const DATA_DIR = '/home/user/.maestro';

function sandbox(patch: Partial<AgentSandbox> = {}): AgentSandbox {
  return { ...DEFAULT_SANDBOX, enabled: true, ...patch };
}

describe('absence de confinement', () => {
  /*
   * L'invariant qui compte : le confinement est une option, jamais un péage.
   * Un agent sans configuration doit produire des options SDK inchangées.
   */
  it('ne rend rien sans configuration', () => {
    expect(buildSandboxSettings(null, { dataDir: DATA_DIR })).toBeUndefined();
  });

  it('ne rend rien quand le confinement est désactivé', () => {
    expect(buildSandboxSettings(DEFAULT_SANDBOX, { dataDir: DATA_DIR })).toBeUndefined();
  });

  it('le défaut est désactivé', () => {
    expect(DEFAULT_SANDBOX.enabled).toBe(false);
  });
});

describe('protections systématiques', () => {
  /*
   * Le jeton et la base ne sont pas négociables : un agent confiné qui lit le
   * jeton appelle l'API et se fait lancer un run non confiné. Le confinement
   * s'annulerait lui-même en une commande.
   */
  it('interdit toujours la lecture du jeton et de la base', () => {
    const settings = buildSandboxSettings(sandbox(), { dataDir: DATA_DIR });
    expect(settings?.filesystem.denyRead).toContain('/home/user/.maestro/token');
    expect(settings?.filesystem.denyRead).toContain('/home/user/.maestro/maestro.db');
  });

  it('les protections ne peuvent pas être retirées par configuration', () => {
    const settings = buildSandboxSettings(sandbox({ denyRead: [] }), { dataDir: DATA_DIR });
    expect(settings?.filesystem.denyRead).toEqual(alwaysProtected(DATA_DIR));
  });

  it('les place avant les chemins de l’agent', () => {
    const settings = buildSandboxSettings(sandbox({ denyRead: ['/secrets'] }), {
      dataDir: DATA_DIR,
    });
    expect(settings?.filesystem.denyRead.at(-1)).toBe('/secrets');
    expect(settings?.filesystem.denyRead).toHaveLength(3);
  });

  it('ne duplique pas un chemin déjà protégé', () => {
    const settings = buildSandboxSettings(
      sandbox({ denyRead: ['/home/user/.maestro/token', '/autre'] }),
      { dataDir: DATA_DIR },
    );
    expect(settings?.filesystem.denyRead).toEqual([
      '/home/user/.maestro/token',
      '/home/user/.maestro/maestro.db',
      '/autre',
    ]);
  });
});

describe('traduction des réglages', () => {
  it('coupe le réseau quand aucun domaine n’est listé', () => {
    const settings = buildSandboxSettings(sandbox(), { dataDir: DATA_DIR });
    expect(settings?.network.allowedDomains).toEqual([]);
    expect(settings?.network.strictAllowlist).toBe(true);
  });

  it('reporte les domaines autorisés et le mode strict', () => {
    const settings = buildSandboxSettings(
      sandbox({ allowedDomains: ['*.cneidf.net', 'registry.npmjs.org'], strictAllowlist: false }),
      { dataDir: DATA_DIR },
    );
    expect(settings?.network.allowedDomains).toEqual(['*.cneidf.net', 'registry.npmjs.org']);
    expect(settings?.network.strictAllowlist).toBe(false);
  });

  it('reporte l’exigence de disponibilité', () => {
    expect(
      buildSandboxSettings(sandbox({ failIfUnavailable: true }), { dataDir: DATA_DIR })
        ?.failIfUnavailable,
    ).toBe(true);
  });

  it('reporte les chemins ouverts en écriture', () => {
    const settings = buildSandboxSettings(sandbox({ allowWrite: ['/tmp/partage'] }), {
      dataDir: DATA_DIR,
    });
    expect(settings?.filesystem.allowWrite).toEqual(['/tmp/partage']);
  });

  it('écarte les entrées vides et les doublons', () => {
    const settings = buildSandboxSettings(
      sandbox({
        allowedDomains: ['a.fr', '  ', 'a.fr'],
        allowWrite: ['/tmp', '/tmp', ''],
        denyRead: ['   '],
      }),
      { dataDir: DATA_DIR },
    );
    expect(settings?.network.allowedDomains).toEqual(['a.fr']);
    expect(settings?.filesystem.allowWrite).toEqual(['/tmp']);
    expect(settings?.filesystem.denyRead).toEqual(alwaysProtected(DATA_DIR));
  });
});

describe('résumé pour le journal', () => {
  it('ne dit rien sans confinement', () => {
    expect(describeSandbox(undefined)).toBeNull();
  });

  it('annonce un réseau coupé', () => {
    const settings = buildSandboxSettings(sandbox(), { dataDir: DATA_DIR });
    expect(describeSandbox(settings)).toContain('réseau coupé');
    expect(describeSandbox(settings)).toContain('au mieux');
  });

  it('annonce les domaines et le mode exigé', () => {
    const settings = buildSandboxSettings(
      sandbox({ allowedDomains: ['a.fr'], failIfUnavailable: true, allowWrite: ['/tmp'] }),
      { dataDir: DATA_DIR },
    );
    const text = describeSandbox(settings) ?? '';
    expect(text).toContain('exigé');
    expect(text).toContain('a.fr');
    expect(text).toContain('1 chemin(s)');
  });
});
