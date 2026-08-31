/**
 * Lecture et livraison du travail produit dans le répertoire d'un agent.
 *
 * Un orchestrateur d'agents de code qui ne montre pas ce que ses agents ont
 * changé demande une confiance aveugle. Ce module comble ce vide : il prend un
 * point de référence au démarrage d'un run, et sait dire à l'arrivée quels
 * fichiers ont bougé, puis proposer un patch ou une branche.
 *
 * Trois partis pris, qui expliquent la forme du code :
 *
 * 1. **Le répertoire de l'agent n'est pas forcément un dépôt.** Par défaut,
 *    Maestro fabrique un workspace qui ne contient que `CLAUDE.md` et
 *    `MEMORY.md`. La fonctionnalité doit donc se désactiver proprement et le
 *    dire, jamais échouer.
 * 2. **On n'attribue pas à un run ce qu'il n'a pas fait.** Les fichiers déjà
 *    modifiés au démarrage sont marqués comme tels : un humain qui édite en
 *    parallèle ne doit pas voir son travail imputé à l'agent.
 * 3. **Rien n'est écrit sans demande explicite.** Aucun commit automatique,
 *    aucune branche existante réutilisée, et jamais de `push` — livrer sur un
 *    remote est une décision humaine.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChangeStatus, ChangedFile, CommitResult, WorkspaceChanges } from '@maestro/shared';

const run = promisify(execFile);

/** Au-delà, le diff est tronqué : un patch de plusieurs mégaoctets ne se lit pas. */
export const DIFF_MAX_CHARS = 200_000;
/** Garde-fou de mémoire sur la sortie de git, indépendant de la troncature d'affichage. */
const MAX_BUFFER = 8 * 1024 * 1024;
/** Une commande git qui dépasse ce délai est considérée comme bloquée. */
const TIMEOUT_MS = 15_000;
/** Nombre de fichiers neufs dont le contenu est ajouté au diff. */
const UNTRACKED_DIFF_MAX_FILES = 25;
/** Au-delà, un fichier neuf n'est que listé : son contenu noierait le diff. */
const UNTRACKED_DIFF_MAX_BYTES = 100_000;

export class WorkspaceGitError extends Error {}

/**
 * Exécute git sans passer par un shell : aucune interpolation possible.
 *
 * `tolerateExitCode` existe pour `diff --no-index`, qui rend 1 dès qu'il trouve
 * une différence — c'est-à-dire toujours, dans notre usage — en écrivant le
 * diff sur la sortie standard. Sans cette porte, sa sortie serait jetée avec
 * l'exception.
 */
async function git(
  dir: string,
  args: string[],
  options: { tolerateExitCode?: number; includeStderr?: boolean } = {},
): Promise<string> {
  try {
    const { stdout, stderr } = await run('git', ['-C', dir, ...args], {
      maxBuffer: MAX_BUFFER,
      timeout: TIMEOUT_MS,
      windowsHide: true,
    });
    /*
     * `git push` écrit sur stderr — les lignes « remote: » comprises, dont
     * celle qui porte l'URL de création de merge request. Lire stdout seul
     * n'aurait jamais rien trouvé, et l'absence de lien serait passée pour un
     * dépôt sans forge.
     */
    return options.includeStderr ? `${stdout}\n${stderr}` : stdout;
  } catch (err) {
    if (
      options.tolerateExitCode !== undefined &&
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      err.code === options.tolerateExitCode &&
      'stdout' in err &&
      typeof err.stdout === 'string'
    ) {
      return err.stdout;
    }
    const message =
      err instanceof Error && 'stderr' in err && typeof err.stderr === 'string' && err.stderr.trim()
        ? err.stderr.trim()
        : err instanceof Error
          ? err.message
          : String(err);
    throw new WorkspaceGitError(message);
  }
}

/** Le répertoire est-il la racine d'un dépôt utilisable ? */
export async function isRepo(dir: string): Promise<boolean> {
  try {
    const out = await git(dir, ['rev-parse', '--is-inside-work-tree']);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Point de référence pris au démarrage d'un run.
 *
 * `dirty` est la clé de l'honnêteté du diff : sans cette liste, impossible de
 * distinguer plus tard ce que l'agent a écrit de ce qui traînait déjà.
 */
export interface GitSnapshot {
  head: string | null;
  branch: string | null;
  dirty: string[];
}

/** Fichiers modifiés au sens de `git status --porcelain`, chemins normalisés. */
async function dirtyPaths(dir: string): Promise<string[]> {
  const out = await git(dir, ['status', '--porcelain', '--untracked-files=all']);
  return (
    out
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      // Un renommage s'écrit « ancien -> nouveau » : les deux comptent comme sales.
      .flatMap((path) => (path.includes(' -> ') ? path.split(' -> ') : [path]))
      .map((path) => path.replace(/^"|"$/g, ''))
  );
}

export async function snapshot(dir: string): Promise<GitSnapshot | null> {
  if (!(await isRepo(dir))) return null;
  /* Un dépôt fraîchement initialisé n'a pas de HEAD : ce n'est pas une erreur,
     c'est l'état normal avant le premier commit. */
  let head: string | null = null;
  try {
    head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  } catch {
    head = null;
  }
  let branch: string | null = null;
  try {
    branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (branch === 'HEAD') branch = null; // détaché
  } catch {
    branch = null;
  }
  return { head, branch, dirty: await dirtyPaths(dir) };
}

export type { ChangeStatus, ChangedFile, CommitResult, WorkspaceChanges };

function statusOf(code: string, untracked: boolean): ChangeStatus {
  if (untracked) return 'untracked';
  if (code.includes('D')) return 'deleted';
  if (code.includes('A')) return 'added';
  if (code.includes('R')) return 'renamed';
  return 'modified';
}

/**
 * Compte les lignes ajoutées et retirées par fichier.
 *
 * `--numstat` est utilisé plutôt qu'un comptage maison sur le diff : c'est git
 * qui décide ce qui est binaire (auquel cas il rend « - - »), et refaire ce
 * jugement à la main se tromperait.
 */
async function numstat(dir: string, args: string[]): Promise<Map<string, [number, number]>> {
  const out = await git(dir, ['diff', '--numstat', ...args]);
  const map = new Map<string, [number, number]>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [add, del, ...rest] = line.split('\t');
    const path = rest.join('\t');
    if (!path) continue;
    map.set(path, [Number(add) || 0, Number(del) || 0]);
  }
  return map;
}

/**
 * Diff des fichiers neufs, que `git diff HEAD` ignore par construction.
 *
 * C'est le cas le plus fréquent pour un agent — il écrit du neuf plus souvent
 * qu'il ne modifie —, donc l'omettre viderait le diff précisément quand il
 * compte. Constaté en essayant sur un vrai dépôt.
 *
 * `--no-index` compare deux chemins hors dépôt : aucun ajout à l'index, donc
 * aucun effet de bord sur le travail en cours de l'utilisateur. C'est ce qui
 * disqualifie l'astuce habituelle du `git add --intent-to-add`.
 */
async function untrackedDiff(dir: string, paths: string[]): Promise<string> {
  const { statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const parts: string[] = [];

  for (const path of paths.slice(0, UNTRACKED_DIFF_MAX_FILES)) {
    let size: number;
    try {
      const stat = statSync(join(dir, path));
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch {
      continue; // supprimé entre-temps
    }
    if (size > UNTRACKED_DIFF_MAX_BYTES) {
      parts.push(
        `--- /dev/null\n+++ b/${path}\n@@ fichier neuf de ${Math.round(size / 1024)} ko, contenu non affiché @@`,
      );
      continue;
    }
    try {
      const out = await git(dir, ['diff', '--no-index', '--no-color', '--', '/dev/null', path], {
        tolerateExitCode: 1,
      });
      if (out.trim()) parts.push(out);
    } catch {
      // Fichier illisible ou binaire refusé : il reste listé plus haut, sans son contenu.
    }
  }

  if (paths.length > UNTRACKED_DIFF_MAX_FILES) {
    parts.push(
      `@@ ${paths.length - UNTRACKED_DIFF_MAX_FILES} autre(s) fichier(s) neuf(s) non affiché(s) @@`,
    );
  }
  return parts.join('\n');
}

/**
 * État des modifications par rapport au point de référence.
 *
 * Le diff est calculé contre `HEAD` et non contre `baseSha` : si un commit a eu
 * lieu pendant le run (un agent qui commite lui-même), le comparer au SHA de
 * départ afficherait ses propres commits comme des modifications en attente.
 * Le SHA de départ reste exposé pour que l'interface puisse signaler l'écart.
 */
export async function changes(dir: string, base: GitSnapshot | null): Promise<WorkspaceChanges> {
  if (!(await isRepo(dir))) {
    return {
      available: false,
      reason:
        "Le répertoire de cet agent n'est pas un dépôt git : Maestro ne peut pas suivre les modifications.",
      branch: null,
      baseSha: base?.head ?? null,
      files: [],
      diff: '',
      diffTruncated: false,
    };
  }

  const preexisting = new Set(base?.dirty ?? []);
  const statusOut = await git(dir, ['status', '--porcelain', '--untracked-files=all']);
  const stats = await numstat(dir, ['HEAD']);

  const files: ChangedFile[] = [];
  for (const line of statusOut.split('\n')) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const raw = line.slice(3).trim().replace(/^"|"$/g, '');
    const path = raw.includes(' -> ') ? (raw.split(' -> ')[1] ?? raw) : raw;
    const untracked = code.trim() === '??';
    const [additions, deletions] = stats.get(path) ?? [0, 0];
    files.push({
      path,
      status: statusOf(code, untracked),
      additions,
      deletions,
      preexisting: preexisting.has(path),
    });
  }

  let diff = '';
  try {
    diff = await git(dir, ['diff', 'HEAD']);
  } catch {
    // Dépôt sans commit : il n'y a rien à comparer, seuls les non-suivis existent.
    diff = '';
  }

  const untracked = files.filter((f) => f.status === 'untracked').map((f) => f.path);
  if (untracked.length > 0) {
    const extra = await untrackedDiff(dir, untracked);
    if (extra) diff = diff ? `${diff}\n${extra}` : extra;
  }

  const diffTruncated = diff.length > DIFF_MAX_CHARS;

  return {
    available: true,
    reason: null,
    branch: (await snapshot(dir))?.branch ?? null,
    baseSha: base?.head ?? null,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    diff: diffTruncated ? `${diff.slice(0, DIFF_MAX_CHARS)}\n…(diff tronqué)` : diff,
    diffTruncated,
  };
}

/** Patch complet, prêt à `git apply`. Non tronqué : un patch amputé ne s'applique pas. */
export async function patch(dir: string): Promise<string> {
  if (!(await isRepo(dir))) throw new WorkspaceGitError("Ce répertoire n'est pas un dépôt git.");
  /* `--binary` pour que les fichiers binaires survivent au transport, et
     `--no-color` parce qu'un patch colorisé est inapplicable. */
  return git(dir, ['diff', '--binary', '--no-color', 'HEAD']);
}

/**
 * Une opération d'écriture est-elle sûre ici ?
 *
 * Commiter au milieu d'un merge ou d'un rebase interrompu laisserait le dépôt
 * dans un état que l'utilisateur ne saurait pas défaire. Mieux vaut refuser et
 * le dire.
 */
async function assertWritable(dir: string): Promise<void> {
  const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim();
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const blockers: [string, string][] = [
    ['MERGE_HEAD', 'une fusion est en cours'],
    ['rebase-merge', 'un rebase est en cours'],
    ['rebase-apply', 'un rebase ou un am est en cours'],
    ['CHERRY_PICK_HEAD', 'un cherry-pick est en cours'],
  ];
  for (const [marker, label] of blockers) {
    if (existsSync(join(gitDir, marker))) {
      throw new WorkspaceGitError(
        `Opération refusée : ${label} dans ce dépôt. Termine-la avant de livrer depuis Maestro.`,
      );
    }
  }
}

/** Nom de branche valide au sens de git, et libre. */
async function assertBranchAvailable(dir: string, branch: string): Promise<void> {
  try {
    await git(dir, ['check-ref-format', '--branch', branch]);
  } catch {
    throw new WorkspaceGitError(`Nom de branche invalide : ${branch}`);
  }
  try {
    await git(dir, ['rev-parse', '--verify', `refs/heads/${branch}`]);
  } catch {
    return; // absente : c'est ce qu'on veut
  }
  throw new WorkspaceGitError(
    `La branche ${branch} existe déjà. Maestro ne réécrit jamais une branche existante.`,
  );
}

/**
 * Crée une branche depuis l'état courant et y commite les modifications.
 *
 * Toujours une branche neuve, jamais la branche courante : le pire scénario
 * serait qu'un commit produit par une machine atterrisse sur `main` sans que
 * personne l'ait demandé.
 */
export async function commitToBranch(
  dir: string,
  options: { branch: string; message: string; paths?: string[] },
): Promise<CommitResult> {
  if (!(await isRepo(dir))) throw new WorkspaceGitError("Ce répertoire n'est pas un dépôt git.");
  await assertWritable(dir);
  await assertBranchAvailable(dir, options.branch);

  const before = await dirtyPaths(dir);
  if (before.length === 0) throw new WorkspaceGitError('Aucune modification à livrer.');

  await git(dir, ['checkout', '-b', options.branch]);
  try {
    if (options.paths && options.paths.length > 0) {
      await git(dir, ['add', '--', ...options.paths]);
    } else {
      await git(dir, ['add', '--all']);
    }
    /* `--no-verify` n'est pas utilisé : si le dépôt a un hook de pre-commit,
       c'est qu'il a une raison, et un commit fabriqué par Maestro n'a aucun
       privilège particulier. */
    await git(dir, ['commit', '--message', options.message]);
  } catch (err) {
    // On ne laisse pas l'utilisateur sur une branche à moitié faite.
    await git(dir, ['checkout', '-']).catch(() => undefined);
    await git(dir, ['branch', '-D', options.branch]).catch(() => undefined);
    throw err;
  }

  const sha = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  const count = (await git(dir, ['show', '--name-only', '--format=', 'HEAD']))
    .split('\n')
    .filter(Boolean).length;
  return { branch: options.branch, sha, files: count };
}

/** Résultat d'une publication de branche. */
export interface PushResult {
  branch: string;
  remote: string;
  /** Lien de création de merge request, quand on a su le déterminer. */
  mergeRequestUrl: string | null;
}

/**
 * Lit l'URL de création de MR proposée par la forge.
 *
 * GitLab et GitHub l'écrivent tous deux dans la sortie de `git push`, préfixée
 * de `remote:`. La lire plutôt que la fabriquer évite d'avoir à connaître la
 * forge, son domaine, le chemin du projet et sa convention d'URL — et c'est la
 * forge elle-même qui la donne, donc elle est juste par construction.
 */
export function mergeRequestUrlFrom(pushOutput: string): string | null {
  const match = /https?:\/\/\S*(?:merge_requests\/new|\/compare\/|\/pull\/new\/)\S*/.exec(
    pushOutput,
  );
  // Les sorties git terminent souvent par de la ponctuation collée à l'URL.
  return match ? match[0].replace(/[.,)\]]+$/, '') : null;
}

/**
 * Publie une branche sur le dépôt distant.
 *
 * Aucun jeton de forge n'est demandé : le `push` emprunte les identifiants déjà
 * configurés sur la machine, ceux dont l'utilisateur se sert lui-même. Créer la
 * merge request par API aurait exigé un jeton, l'URL de l'instance et le chemin
 * du projet — trois choses que Maestro n'a pas, pour un gain nul puisque la
 * forge propose déjà le lien.
 *
 * 🔒 On ne pousse jamais que la branche demandée, et jamais en force.
 */
export async function pushBranch(
  dir: string,
  options: { branch: string; remote?: string },
): Promise<PushResult> {
  if (!(await isRepo(dir))) throw new WorkspaceGitError("Ce répertoire n'est pas un dépôt git.");
  const remote = options.remote ?? 'origin';

  const remotes = (await git(dir, ['remote'])).split('\n').map((r) => r.trim());
  if (!remotes.includes(remote)) {
    throw new WorkspaceGitError(
      `Aucun dépôt distant « ${remote} » : la branche reste locale. ` +
        `Ajoute-le avec « git remote add ${remote} <url> ».`,
    );
  }

  const exists = await git(dir, ['rev-parse', '--verify', options.branch]).catch(() => '');
  if (!exists.trim()) {
    throw new WorkspaceGitError(`Branche introuvable : ${options.branch}`);
  }

  /*
   * `--set-upstream` et rien d'autre. Pas de `--force`, pas de `--all` : une
   * branche fabriquée par un agent n'a aucun privilège particulier, et écraser
   * un historique distant n'est jamais une opération que Maestro décide seul.
   */
  const output = await git(dir, ['push', '--set-upstream', remote, options.branch], {
    includeStderr: true,
  });
  return { branch: options.branch, remote, mergeRequestUrl: mergeRequestUrlFrom(output) };
}

/**
 * Nom de branche dérivé d'un run.
 *
 * Le prompt sert de libellé parce que c'est ce dont l'humain se souvient ; le
 * fragment d'identifiant garantit l'unicité quand le même prompt est rejoué.
 */
export function branchNameFor(prompt: string, runId: string): string {
  const slug = prompt
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `maestro/${slug || 'run'}-${runId.slice(0, 8)}`;
}
