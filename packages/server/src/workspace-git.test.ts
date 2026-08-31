/**
 * Tests du suivi git des répertoires d'agents.
 *
 * Sur de vrais dépôts, créés dans un répertoire temporaire : ce module ne fait
 * qu'orchestrer des commandes git, donc le simuler ne testerait que mes propres
 * hypothèses sur la sortie de git — précisément ce qui peut être faux.
 *
 * Ce qui doit tenir, parce que ça touche le dépôt de quelqu'un :
 *
 * - un répertoire sans dépôt se signale, il n'échoue pas ;
 * - le travail déjà en cours avant le run n'est pas imputé à l'agent ;
 * - une branche existante n'est jamais réécrite, et un merge en cours bloque.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WorkspaceGitError,
  branchNameFor,
  changes,
  commitToBranch,
  isRepo,
  mergeRequestUrlFrom,
  patch,
  pushBranch,
  snapshot,
} from './workspace-git.ts';

let dir: string;

function g(...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

function write(path: string, content: string): void {
  writeFileSync(join(dir, path), content, 'utf8');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'maestro-git-'));
  g('init', '--initial-branch=main');
  g('config', 'user.email', 'test@maestro.local');
  g('config', 'user.name', 'Maestro Test');
  // Un hook de pre-commit hérité de la machine ferait échouer les commits ici.
  g('config', 'core.hooksPath', join(dir, '.git', 'hooks-vides'));
  mkdirSync(join(dir, '.git', 'hooks-vides'), { recursive: true });
  write('depart.txt', 'ligne un\n');
  g('add', '.');
  g('commit', '--message', 'depart');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('détection du dépôt', () => {
  it('reconnaît un dépôt', async () => {
    expect(await isRepo(dir)).toBe(true);
  });

  it('se signale sans échouer sur un répertoire ordinaire', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'maestro-plain-'));
    try {
      expect(await isRepo(plain)).toBe(false);
      expect(await snapshot(plain)).toBeNull();
      const result = await changes(plain, null);
      expect(result.available).toBe(false);
      expect(result.reason).toContain('dépôt git');
      expect(result.files).toEqual([]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('modifications', () => {
  it('liste un fichier modifié avec son compte de lignes', async () => {
    const base = await snapshot(dir);
    write('depart.txt', 'ligne un\nligne deux\n');
    const result = await changes(dir, base);
    expect(result.available).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      path: 'depart.txt',
      status: 'modified',
      additions: 1,
      deletions: 0,
      preexisting: false,
    });
    expect(result.diff).toContain('ligne deux');
  });

  it('repère un fichier non suivi', async () => {
    const base = await snapshot(dir);
    write('nouveau.txt', 'contenu\n');
    const result = await changes(dir, base);
    expect(result.files[0]).toMatchObject({ path: 'nouveau.txt', status: 'untracked' });
  });

  it('repère une suppression', async () => {
    const base = await snapshot(dir);
    rmSync(join(dir, 'depart.txt'));
    const result = await changes(dir, base);
    expect(result.files[0]).toMatchObject({ path: 'depart.txt', status: 'deleted' });
  });

  it("n'impute pas à l'agent le travail déjà en cours au démarrage", async () => {
    write('depart.txt', 'modifié à la main avant le run\n');
    const base = await snapshot(dir);
    write('ecrit-par-agent.txt', 'sortie du run\n');

    const result = await changes(dir, base);
    const byPath = new Map(result.files.map((f) => [f.path, f]));
    expect(byPath.get('depart.txt')?.preexisting).toBe(true);
    expect(byPath.get('ecrit-par-agent.txt')?.preexisting).toBe(false);
  });

  it('expose la branche et le SHA de départ', async () => {
    const base = await snapshot(dir);
    write('x.txt', 'x\n');
    const result = await changes(dir, base);
    expect(result.branch).toBe('main');
    expect(result.baseSha).toBe(base?.head);
  });

  it('rend un patch applicable ailleurs', async () => {
    const base = await snapshot(dir);
    write('depart.txt', 'ligne un\nligne deux\n');
    const text = await patch(dir);
    expect(text).toContain('--- a/depart.txt');
    expect(text).toContain('+ligne deux');
    expect(base).not.toBeNull();
  });
});

describe('livraison sur une branche', () => {
  it('crée la branche, commite, et rend le SHA', async () => {
    write('depart.txt', 'ligne un\nligne deux\n');
    write('nouveau.txt', 'neuf\n');
    const result = await commitToBranch(dir, {
      branch: 'maestro/essai-1234abcd',
      message: 'Travail de l’agent',
    });
    expect(result.branch).toBe('maestro/essai-1234abcd');
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.files).toBe(2);
    expect(g('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('maestro/essai-1234abcd');
    expect(g('status', '--porcelain').trim()).toBe('');
  });

  it('refuse une branche déjà existante plutôt que de la réécrire', async () => {
    g('branch', 'maestro/deja-la');
    write('depart.txt', 'autre\n');
    await expect(commitToBranch(dir, { branch: 'maestro/deja-la', message: 'x' })).rejects.toThrow(
      WorkspaceGitError,
    );
    // La branche d'origine est intacte, le travail toujours en place.
    expect(g('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(g('status', '--porcelain')).toContain('depart.txt');
  });

  it('refuse un nom de branche invalide', async () => {
    write('depart.txt', 'autre\n');
    await expect(commitToBranch(dir, { branch: 'a b..c', message: 'x' })).rejects.toThrow(
      WorkspaceGitError,
    );
  });

  it("refuse de livrer quand il n'y a rien à livrer", async () => {
    await expect(commitToBranch(dir, { branch: 'maestro/vide', message: 'x' })).rejects.toThrow(
      /Aucune modification/,
    );
  });

  it('refuse de commiter au milieu d’une fusion interrompue', async () => {
    // Deux branches qui touchent la même ligne : la fusion s'arrête en conflit.
    g('checkout', '-b', 'cote');
    write('depart.txt', 'version cote\n');
    g('commit', '--all', '--message', 'cote');
    g('checkout', 'main');
    write('depart.txt', 'version main\n');
    g('commit', '--all', '--message', 'main');
    try {
      g('merge', 'cote');
    } catch {
      // conflit attendu
    }
    await expect(
      commitToBranch(dir, { branch: 'maestro/pendant-merge', message: 'x' }),
    ).rejects.toThrow(/fusion est en cours/);
  });

  it('ne livre que les chemins demandés', async () => {
    write('garde.txt', 'à livrer\n');
    write('laisse.txt', 'à laisser\n');
    await commitToBranch(dir, {
      branch: 'maestro/partiel',
      message: 'partiel',
      paths: ['garde.txt'],
    });
    expect(g('show', '--name-only', '--format=', 'HEAD')).toContain('garde.txt');
    expect(g('status', '--porcelain')).toContain('laisse.txt');
  });
});

describe('nom de branche dérivé du run', () => {
  it('translittère, tronque et suffixe par le run', () => {
    const name = branchNameFor('Corriger l’export comptable en écritures', 'run_abcdef123456');
    expect(name).toBe('maestro/corriger-l-export-comptable-en-ecritures-run_abcd');
  });

  it('reste valide quand le prompt ne donne aucun mot utilisable', () => {
    expect(branchNameFor('!!! ???', 'run_12345678')).toBe('maestro/run-run_1234');
  });
});

describe('diff des fichiers neufs', () => {
  it('montre le contenu d’un fichier neuf, que git diff HEAD ignore', async () => {
    const base = await snapshot(dir);
    write('neuf.txt', 'première ligne\ndeuxième ligne\n');
    const result = await changes(dir, base);
    expect(result.diff).toContain('neuf.txt');
    expect(result.diff).toContain('+première ligne');
  });

  it('liste un fichier neuf volumineux sans en afficher le contenu', async () => {
    const base = await snapshot(dir);
    write('gros.txt', 'x'.repeat(150_000));
    const result = await changes(dir, base);
    expect(result.diff).toContain('gros.txt');
    expect(result.diff).toContain('contenu non affiché');
    expect(result.diff).not.toContain('xxxxxxxxxx');
  });

  it('combine modifications suivies et fichiers neufs', async () => {
    const base = await snapshot(dir);
    write('depart.txt', 'ligne un\nligne deux\n');
    write('neuf.txt', 'contenu neuf\n');
    const result = await changes(dir, base);
    expect(result.diff).toContain('+ligne deux');
    expect(result.diff).toContain('+contenu neuf');
    expect(result.files).toHaveLength(2);
  });
});

describe('lien de merge request', () => {
  /*
   * GitLab et GitHub écrivent tous deux ce lien dans la sortie du push. Le lire
   * plutôt que le fabriquer évite de connaître la forge, son domaine et sa
   * convention d'URL — et il est juste par construction, puisqu'il vient d'elle.
   */
  it('lit le lien proposé par GitLab', () => {
    const sortie = [
      'remote:',
      'remote: To create a merge request for ma-branche, visit:',
      'remote:   https://gitlab.cneidf.net/equipe/projet/-/merge_requests/new?merge_request%5Bsource_branch%5D=ma-branche',
      'remote:',
    ].join('\n');
    expect(mergeRequestUrlFrom(sortie)).toContain('/-/merge_requests/new');
  });

  it('lit le lien proposé par GitHub', () => {
    const sortie =
      'remote: Create a pull request for ma-branche on GitHub by visiting:\n' +
      'remote:      https://github.com/org/depot/pull/new/ma-branche\n';
    expect(mergeRequestUrlFrom(sortie)).toBe('https://github.com/org/depot/pull/new/ma-branche');
  });

  it('retire la ponctuation collée à l’URL', () => {
    expect(mergeRequestUrlFrom('visitez https://forge.fr/p/-/merge_requests/new.')).toBe(
      'https://forge.fr/p/-/merge_requests/new',
    );
  });

  it('rend null quand la forge ne propose rien', () => {
    expect(mergeRequestUrlFrom('To /srv/depot.git\n * [new branch] x -> x')).toBeNull();
  });
});

describe('publication de branche', () => {
  /** Dépôt nu servant de distant, pour pousser pour de vrai. */
  let remoteDir: string;

  beforeEach(() => {
    remoteDir = mkdtempSync(join(tmpdir(), 'maestro-remote-'));
    execFileSync('git', ['init', '--bare', '--initial-branch=main', remoteDir], {
      encoding: 'utf8',
    });
  });

  afterEach(() => {
    rmSync(remoteDir, { recursive: true, force: true });
  });

  it('refuse quand aucun distant n’est configuré', async () => {
    write('neuf.txt', 'x');
    await commitToBranch(dir, { branch: 'maestro/essai', message: 'essai' });
    await expect(pushBranch(dir, { branch: 'maestro/essai' })).rejects.toThrow(/distant/);
  });

  it('refuse une branche inexistante', async () => {
    g('remote', 'add', 'origin', remoteDir);
    await expect(pushBranch(dir, { branch: 'maestro/fantome' })).rejects.toThrow(/introuvable/);
  });

  it('pousse la branche et la rend visible sur le distant', async () => {
    g('remote', 'add', 'origin', remoteDir);
    write('neuf.txt', 'contenu\n');
    await commitToBranch(dir, { branch: 'maestro/livraison', message: 'livraison' });

    const result = await pushBranch(dir, { branch: 'maestro/livraison' });
    expect(result.branch).toBe('maestro/livraison');
    expect(result.remote).toBe('origin');

    const distant = execFileSync('git', ['-C', remoteDir, 'branch', '--list'], {
      encoding: 'utf8',
    });
    expect(distant).toContain('maestro/livraison');
  });

  /* Un dépôt nu local ne propose aucun lien : l'absence doit se lire comme
     « pas de forge », pas comme une erreur. */
  it('rend un lien nul quand le distant n’en propose pas', async () => {
    g('remote', 'add', 'origin', remoteDir);
    write('neuf.txt', 'contenu\n');
    await commitToBranch(dir, { branch: 'maestro/sans-lien', message: 'x' });
    const result = await pushBranch(dir, { branch: 'maestro/sans-lien' });
    expect(result.mergeRequestUrl).toBeNull();
  });
});
