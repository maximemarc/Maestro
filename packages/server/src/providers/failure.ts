/**
 * Classification des échecs de tentative.
 *
 * Tout le comportement de repli découle d'ici : un quota s'attend ou se
 * contourne par bascule, une saturation ponctuelle se réessaie après quelques
 * secondes, une authentification cassée ne se réessaie pas du tout. Confondre
 * ces cas produit soit un run immobilisé des heures, soit un martèlement
 * inutile d'un compte épuisé.
 *
 * ⚠ Ces règles sont des **heuristiques sur des formes de messages observées**,
 * pas un contrat d'API. Aucun fournisseur ne garantit la stabilité de ses
 * libellés. Deux conséquences assumées :
 *
 *  1. le défaut est `fatal` — on préfère s'arrêter et le dire plutôt que de
 *     réessayer en boucle sur une erreur mal comprise ;
 *  2. la classe retenue est **affichée** sur la tentative, pour qu'un
 *     classement erroné se voie au lieu de se deviner.
 *
 * Seules deux sources de délai sont considérées comme fiables : l'en-tête
 * `retry-after` et l'horodatage epoch que Claude Code joint à sa limite d'usage
 * (`…limit reached|1771000000`). Les formulations en prose (« resets at 5pm »)
 * sont volontairement **non** interprétées : sans fuseau explicite, une heure
 * devinée vaut moins qu'un backoff honnête.
 */
import type { FailureClass, FailureVerdict } from '@maestro/shared';

/** Longueur max du message conservé : de quoi diagnostiquer, pas de quoi noyer. */
const MESSAGE_MAX = 600;

export interface ClassifyInput {
  /** Message d'erreur, corps de réponse, ou concaténation des deux. */
  message: string;
  /** Code HTTP quand il est connu (adaptateur `http-api`). */
  status?: number | null;
  /** En-têtes de réponse, pour `retry-after`. */
  headers?: Record<string, string> | null;
  /** Code d'erreur système Node (`ECONNRESET`…), quand il est disponible. */
  code?: string | null;
  /** Statut déjà décidé par Maestro : annulation, délai, budget. */
  hint?: FailureClass | null;
  /** Injecté par les tests ; `Date.now()` par défaut. */
  now?: number;
}

interface Matcher {
  klass: FailureClass;
  poisonsAccount: boolean;
  /** Motifs recherchés en minuscules, sans accent, dans le message. */
  patterns: RegExp[];
}

/**
 * Ordre significatif : le premier motif qui accroche gagne.
 *
 * `quota` passe avant `rate_limit` parce que la limite d'abonnement de Claude
 * Code arrive parfois avec un 429 : traitée comme une saturation ponctuelle,
 * elle ferait réessayer toutes les 5 secondes pendant cinq heures.
 */
const MATCHERS: Matcher[] = [
  {
    klass: 'quota',
    poisonsAccount: true,
    patterns: [
      /usage limit reached/,
      /\bquota\b.*(exceeded|exhausted|depasse)/,
      /exceeded your.*(quota|usage limit)/,
      /monthly (limit|quota)/,
      /weekly (limit|quota)/,
      /credit balance is too low/,
      /insufficient (credits?|balance|quota|funds)/,
      /plan limit/,
      /out of (credits?|tokens)/,
    ],
  },
  {
    klass: 'auth',
    poisonsAccount: true,
    patterns: [
      /authentication_error/,
      /invalid api[- ]key/,
      /invalid x-api-key/,
      /unauthorized/,
      /oauth token (has )?expired/,
      /token (has )?expired/,
      /please run .?(claude )?(auth )?login/,
      /not logged in/,
      /no credentials/,
      /permission_error/,
      /forbidden/,
    ],
  },
  {
    klass: 'context',
    poisonsAccount: false,
    patterns: [
      /prompt is too long/,
      /context (window|length) exceeded/,
      /maximum context length/,
      /too many tokens/,
      /input length and .max_tokens. exceed/,
      /request too large/,
    ],
  },
  {
    klass: 'rate_limit',
    poisonsAccount: true,
    patterns: [/rate_limit_error/, /rate limit/, /too many requests/, /slow down/],
  },
  {
    klass: 'overloaded',
    poisonsAccount: false,
    patterns: [
      /overloaded_error/,
      /overloaded/,
      /service unavailable/,
      /temporarily unavailable/,
      /api_error/,
      /internal server error/,
      /bad gateway/,
      /upstream connect error/,
    ],
  },
  {
    klass: 'transient',
    poisonsAccount: false,
    patterns: [
      /fetch failed/,
      /socket hang up/,
      /network error/,
      /connection (reset|refused|closed|aborted)/,
      /timed? ?out/,
      /getaddrinfo/,
      /dns lookup/,
      /tls|certificate/,
      /stream (ended|closed) unexpectedly/,
    ],
  },
];

/** Codes d'erreur système Node qui désignent sans ambiguïté un incident réseau. */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Minuscules, sans accent : les messages mêlent anglais et français selon l'outil. */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Extrait un délai de réouverture *annoncé*, en millisecondes.
 *
 * Trois sources, par ordre de fiabilité décroissante :
 *  1. `retry-after` en secondes (entier) ou en date HTTP ;
 *  2. l'epoch joint par Claude Code à sa limite d'usage (`…reached|1771000000`) ;
 *  3. un champ `retry_after` / `retryAfter` dans un corps JSON d'erreur.
 *
 * Une valeur négative ou absurde (> 24 h) est ignorée : mieux vaut le backoff
 * qu'une attente calculée sur une horloge désynchronisée.
 */
export function extractRetryAfterMs(input: ClassifyInput): number | null {
  const now = input.now ?? Date.now();
  const MAX_MS = 24 * 60 * 60 * 1000;

  const sane = (ms: number): number | null => (ms > 0 && ms <= MAX_MS ? Math.round(ms) : null);

  const header = findHeader(input.headers ?? null, 'retry-after');
  if (header) {
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds)) {
      const ms = sane(seconds * 1000);
      if (ms !== null) return ms;
    } else {
      const at = Date.parse(header);
      if (Number.isFinite(at)) {
        const ms = sane(at - now);
        if (ms !== null) return ms;
      }
    }
  }

  /* Claude Code joint l'instant de réouverture à sa limite d'usage, séparé par
     une barre verticale. C'est la seule forme temporelle non ambiguë que les
     outils émettent : un epoch, sans fuseau à deviner. */
  const pipe = /limit reached\s*\|\s*(\d{9,14})/i.exec(input.message);
  if (pipe?.[1]) {
    const raw = Number(pipe[1]);
    const at = raw > 1e11 ? raw : raw * 1000; // secondes ou millisecondes
    const ms = sane(at - now);
    if (ms !== null) return ms;
  }

  const json = /"?retry[_-]?after"?\s*[:=]\s*"?(\d+(?:\.\d+)?)"?/i.exec(input.message);
  if (json?.[1]) {
    const seconds = Number(json[1]);
    const ms = sane(seconds * 1000);
    if (ms !== null) return ms;
  }

  return null;
}

function findHeader(headers: Record<string, string> | null, name: string): string | null {
  if (!headers) return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return null;
}

/**
 * Classe un échec depuis un statut HTTP, quand il y en a un.
 *
 * Le statut seul ne suffit pas : un 429 peut porter une limite d'abonnement
 * comme une saturation de débit. Il ne sert donc que de repli, après les
 * motifs textuels.
 */
function fromStatus(status: number): { klass: FailureClass; poisonsAccount: boolean } | null {
  if (status === 401) return { klass: 'auth', poisonsAccount: true };
  if (status === 403) return { klass: 'auth', poisonsAccount: true };
  if (status === 402) return { klass: 'quota', poisonsAccount: true };
  if (status === 413) return { klass: 'context', poisonsAccount: false };
  if (status === 429) return { klass: 'rate_limit', poisonsAccount: true };
  if (status === 408 || status === 425) return { klass: 'transient', poisonsAccount: false };
  if (status >= 500) return { klass: 'overloaded', poisonsAccount: false };
  return null;
}

/**
 * Rend un verdict pour un échec de tentative.
 *
 * `hint` court-circuite tout : quand Maestro sait déjà qu'il a annulé, expiré
 * ou coupé sur budget, l'analyse du message n'apporte rien et risquerait de
 * reclasser une décision interne en incident fournisseur.
 */
export function classifyFailure(input: ClassifyInput): FailureVerdict {
  const message = truncateMessage(input.message);

  if (input.hint === 'cancelled' || input.hint === 'budget') {
    return { klass: input.hint, message, retryAfterMs: null, poisonsAccount: false };
  }

  const retryAfterMs = extractRetryAfterMs({ ...input, message: input.message });

  if (input.code && TRANSIENT_CODES.has(input.code.toUpperCase())) {
    return { klass: 'transient', message, retryAfterMs, poisonsAccount: false };
  }

  const haystack = normalize(input.message);
  for (const matcher of MATCHERS) {
    if (matcher.patterns.some((re) => re.test(haystack))) {
      return {
        klass: matcher.klass,
        message,
        retryAfterMs,
        poisonsAccount: matcher.poisonsAccount,
      };
    }
  }

  if (typeof input.status === 'number') {
    const byStatus = fromStatus(input.status);
    if (byStatus) {
      return { ...byStatus, message, retryAfterMs };
    }
  }

  if (input.hint) {
    return { klass: input.hint, message, retryAfterMs, poisonsAccount: false };
  }

  return { klass: 'fatal', message, retryAfterMs: null, poisonsAccount: false };
}

function truncateMessage(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > MESSAGE_MAX ? `${clean.slice(0, MESSAGE_MAX)}…` : clean;
}

/**
 * Détecte un échec déguisé en succès.
 *
 * Constaté en conditions réelles : lancé sur un profil non authentifié, le
 * Claude Agent SDK ne lève pas et ne rend pas d'erreur — il rend un résultat de
 * sous-type `success` dont le texte est « Not logged in · Please run /login »,
 * avec zéro token consommé. Pris au mot, Maestro clôturait le run en vert, ne
 * déclenchait aucun repli, et livrait ce message comme réponse de l'agent.
 *
 * Le garde-fou tient en une observation : **aucun appel de modèle n'est
 * gratuit.** Un résultat qui n'a consommé ni entrée, ni sortie, ni cache n'a
 * pas été produit par un modèle. Ce n'est qu'à cette condition que le texte est
 * soumis à la classification — sinon une réponse légitime qui parlerait de
 * « rate limit » serait requalifiée en échec.
 *
 * Rend la classe d'échec à retenir, ou `null` si le succès est authentique.
 */
export function classifySilentSuccess(
  resultText: string,
  totalTokens: number,
): FailureClass | null {
  if (totalTokens > 0) return null;
  if (!resultText.trim()) return null;
  const verdict = classifyFailure({ message: resultText });
  return verdict.klass === 'fatal' ? null : verdict.klass;
}

/** Libellés français des classes, pour le transcript et l'interface. */
export const FAILURE_LABELS: Record<FailureClass, string> = {
  quota: 'limite d’usage atteinte',
  rate_limit: 'débit limité',
  overloaded: 'fournisseur saturé',
  auth: 'authentification invalide',
  context: 'contexte dépassé',
  transient: 'incident réseau',
  budget: 'garde-fou Maestro',
  cancelled: 'annulé',
  fatal: 'erreur non récupérable',
};
