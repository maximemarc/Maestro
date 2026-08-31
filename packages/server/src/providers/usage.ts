/**
 * Mesure de la consommation d'un compte sur une fenêtre glissante.
 *
 * Pourquoi ce module existe : jusqu'ici Maestro ne connaissait la limite d'un
 * compte qu'en la heurtant. Il basculait bien, mais après coup — un run
 * commencé, un contexte perdu, un résumé à reconstruire. Savoir que le mur
 * approche permet de changer de compte *avant*, ce qui ne coûte rien.
 *
 * ## Pourquoi les transcripts, et pas autre chose
 *
 * Trois sources ont été examinées sur la machine avant d'écrire une ligne :
 *
 * - **`/usage`** n'existe pas en dehors de la session interactive : ni
 *   sous-commande, ni fichier. Il n'y avait rien à appeler.
 * - **`<config>/stats-cache.json`** contient bien des totaux par jour et par
 *   modèle, mais c'est un cache recalculé de loin en loin — celui de la machine
 *   de développement datait de vingt jours. Une fenêtre de cinq heures ne se
 *   construit pas là-dessus.
 * - **Les transcripts** portent, pour chaque message d'assistant, son
 *   horodatage, son modèle et son `usage`. Ils sont écrits en direct, et ils
 *   couvrent **tout ce qui a tourné sur le profil**, y compris les sessions
 *   lancées à la main hors de Maestro. C'est le seul point de vue complet.
 *
 * 🔒 **Limite de lecture, tenue volontairement.** On lit un horodatage, un
 * modèle, un identifiant de session et des compteurs de tokens. Jamais le
 * contenu d'un message. C'est la même règle que celle du radar de sessions, et
 * elle est ce qui rend acceptable de parcourir les transcripts d'un utilisateur.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AccountUsage, ProviderAccount } from '@maestro/shared';

/** Fenêtre par défaut : la session des abonnements Claude. */
export const DEFAULT_WINDOW_SEC = 5 * 60 * 60;

/**
 * Durée de validité d'une mesure.
 *
 * Un run qui démarre ne doit pas relire des dizaines de fichiers ; une minute
 * de retard sur une fenêtre de cinq heures ne change aucune décision.
 */
const CACHE_TTL_MS = 60_000;

/** Au-delà, un transcript est lu par la fin : les gros fichiers sont anciens. */
const TAIL_BYTES = 4 * 1024 * 1024;

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  sessions: number;
}

const EMPTY: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  sessions: 0,
};

/**
 * Total retenu pour juger de la pression.
 *
 * Le cache de lecture est exclu : facturé une fraction du prix, il gonflerait
 * la mesure d'un facteur dix sur une session qui ne fait que relire un gros
 * contexte, et ferait paraître saturé un compte qui ne l'est pas. L'écriture de
 * cache, elle, coûte plus cher qu'une entrée normale et reste comptée.
 */
export function billableTokens(totals: UsageTotals): number {
  return totals.inputTokens + totals.outputTokens + totals.cacheWriteTokens;
}

/**
 * Répertoire des transcripts d'un compte.
 *
 * `null` pour un compte qui n'en produit pas — clé d'API sur un CLI tiers, API
 * HTTP. Dans ce cas la mesure retombe sur les tentatives enregistrées par
 * Maestro, qui ne voient que ce que Maestro a lancé.
 */
export function transcriptsDirFor(account: ProviderAccount): string | null {
  if (account.kind !== 'claude-sdk') return null;
  const base =
    account.authMode === 'profile' && account.configDir
      ? account.configDir
      : join(homedir(), '.claude');
  const dir = join(base, 'projects');
  return existsSync(dir) ? dir : null;
}

/**
 * Additionne l'usage d'un jeu de transcripts sur la fenêtre.
 *
 * Deux bornes évitent que la mesure coûte plus cher que ce qu'elle économise :
 * seuls les fichiers modifiés depuis le début de la fenêtre sont ouverts, et
 * les gros fichiers ne sont lus que par la fin. Un transcript est append-only :
 * sa fin est son présent.
 */
export function readTranscriptUsage(dir: string, sinceMs: number): UsageTotals {
  const totals: UsageTotals = { ...EMPTY };
  const sessions = new Set<string>();

  for (const file of listTranscripts(dir, sinceMs)) {
    let raw: string;
    try {
      const size = statSync(file).size;
      raw = size > TAIL_BYTES ? readTail(file, TAIL_BYTES) : readFileSync(file, 'utf8');
    } catch {
      continue; // fichier en cours d'écriture ou supprimé : on l'ignore
    }

    for (const line of raw.split('\n')) {
      /* Filtre grossier avant l'analyse : la très grande majorité des lignes
         n'a pas d'usage, et les analyser toutes coûterait cent fois plus. */
      if (!line.includes('"usage"')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // ligne tronquée en fin de fichier pendant l'écriture
      }
      const entry = parsed as {
        timestamp?: string;
        sessionId?: string;
        message?: { usage?: Record<string, unknown> };
      };
      const usage = entry.message?.usage;
      if (!usage || !entry.timestamp) continue;
      const at = Date.parse(entry.timestamp);
      if (!Number.isFinite(at) || at < sinceMs) continue;

      totals.inputTokens += numberAt(usage, 'input_tokens');
      totals.outputTokens += numberAt(usage, 'output_tokens');
      totals.cacheReadTokens += numberAt(usage, 'cache_read_input_tokens');
      totals.cacheWriteTokens += numberAt(usage, 'cache_creation_input_tokens');
      if (entry.sessionId) sessions.add(entry.sessionId);
    }
  }

  totals.sessions = sessions.size;
  return totals;
}

/** Transcripts modifiés depuis le début de la fenêtre. */
function listTranscripts(dir: string, sinceMs: number): string[] {
  const out: string[] = [];
  const walk = (current: string, depth: number): void => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!entry.name.endsWith('.jsonl')) continue;
      try {
        if (statSync(path).mtimeMs >= sinceMs) out.push(path);
      } catch {
        /* disparu entre-temps */
      }
    }
  };
  walk(dir, 0);
  return out;
}

/** Lit les derniers octets d'un fichier, en repartant d'une frontière de ligne. */
function readTail(path: string, bytes: number): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - bytes);
  const buffer = Buffer.alloc(size - start);
  const fd = openSyncSafe(path);
  if (fd === null) return '';
  try {
    readSyncSafe(fd, buffer, start);
  } finally {
    closeSyncSafe(fd);
  }
  const text = buffer.toString('utf8');
  /* La première ligne est presque sûrement coupée en deux : la jeter vaut mieux
     que de compter la moitié d'un objet JSON. */
  const newline = text.indexOf('\n');
  return newline === -1 ? '' : text.slice(newline + 1);
}

function numberAt(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/* Enveloppes minces autour de fs : elles isolent les erreurs d'un fichier en
   cours d'écriture, fréquentes puisqu'on lit pendant qu'une session tourne. */

function openSyncSafe(path: string): number | null {
  try {
    return openSync(path, 'r');
  } catch {
    return null;
  }
}

function readSyncSafe(fd: number, buffer: Buffer, position: number): void {
  try {
    readSync(fd, buffer, 0, buffer.length, position);
  } catch {
    /* lecture partielle : le tampon reste à zéro, la ligne sera ignorée */
  }
}

function closeSyncSafe(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* déjà fermé */
  }
}

/**
 * Pression d'un compte : consommation rapportée à son plafond.
 *
 * `null` quand aucun plafond n'est connu. Ne rien conclure est ici la bonne
 * réponse : comparer à un chiffre inventé produirait des bascules arbitraires,
 * et l'opérateur ne comprendrait pas pourquoi son compte principal est délaissé.
 */
export function pressureOf(billable: number, limit: number | null): number | null {
  if (!limit || limit <= 0) return null;
  return billable / limit;
}

interface CacheEntry {
  at: number;
  usage: AccountUsage;
}

/**
 * Mesure la consommation des comptes, avec cache.
 *
 * La dépendance à la base est passée en fonction plutôt qu'en objet : ce
 * service n'a besoin que d'additionner des tentatives, et le laisser voir tout
 * le `Store` inviterait à y ajouter autre chose.
 */
export class UsageTracker {
  private cache = new Map<string, CacheEntry>();

  constructor(private attemptTotals: (accountId: string, sinceIso: string) => UsageTotals) {}

  /** Oublie les mesures — après un run, ou sur demande explicite. */
  forget(accountId?: string): void {
    if (accountId === undefined) this.cache.clear();
    else this.cache.delete(accountId);
  }

  usageFor(account: ProviderAccount, nowMs = Date.now()): AccountUsage {
    const cached = this.cache.get(account.id);
    if (cached && nowMs - cached.at < CACHE_TTL_MS) return cached.usage;

    const windowSec = account.usageWindowSec > 0 ? account.usageWindowSec : DEFAULT_WINDOW_SEC;
    const sinceMs = nowMs - windowSec * 1000;
    const since = new Date(sinceMs).toISOString();

    const dir = transcriptsDirFor(account);
    let totals: UsageTotals;
    let source: AccountUsage['source'];

    if (account.kind === 'claude-sdk') {
      /*
       * Les transcripts incluent déjà les runs lancés par Maestro : additionner
       * les tentatives par-dessus compterait deux fois le même travail.
       *
       * Répertoire absent = profil qui n'a encore rien exécuté. C'est une
       * consommation nulle, pas une mesure impossible — les confondre ferait
       * afficher « non mesurable » sur un compte neuf, et priverait
       * l'anticipation d'un compte pourtant idéal pour prendre le relais.
       */
      totals = dir ? readTranscriptUsage(dir, sinceMs) : { ...EMPTY };
      source = 'transcripts';
    } else if (account.kind === 'http-api') {
      totals = this.attemptTotals(account.id, since);
      source = 'attempts';
    } else {
      /* Un moteur CLI tiers ne rapporte pas ses tokens : prétendre le contraire
         afficherait une jauge à zéro qui passerait pour « compte au repos ». */
      totals = { ...EMPTY };
      source = 'unavailable';
    }

    const billable = billableTokens(totals);
    const declared = account.windowTokenLimit;
    const limit = declared ?? account.learnedTokenLimit;

    const usage: AccountUsage = {
      accountId: account.id,
      source,
      windowSec,
      since,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      billableTokens: billable,
      costUsd: totals.costUsd,
      sessions: totals.sessions,
      limitTokens: source === 'unavailable' ? null : limit,
      limitLearned: declared === null && account.learnedTokenLimit !== null,
      pressure: source === 'unavailable' ? null : pressureOf(billable, limit),
    };
    this.cache.set(account.id, { at: nowMs, usage });
    return usage;
  }
}
