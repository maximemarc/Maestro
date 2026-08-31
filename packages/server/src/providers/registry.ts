/**
 * Registre des fournisseurs : comptes, politiques, santé, environnement
 * d'exécution.
 *
 * C'est le seul endroit qui sait traduire « ce compte » en « ces variables
 * d'environnement ». Cette concentration est délibérée : une clé d'API ne doit
 * exister qu'entre `process.env` et le processus fils, jamais en base, jamais
 * dans une réponse HTTP, jamais dans le bus d'événements.
 */
import {
  API_BASE_URLS,
  CLI_DEFAULTS,
  PROVIDER_CAPABILITIES,
  PROVIDER_KINDS,
  PROVIDER_LABELS,
  type AgentConfig,
  type FailureVerdict,
  type ProviderAccount,
  type ProviderAccountCreate,
  type ProviderKind,
  type ProviderProbe,
  type ResiliencePolicy,
  type ResiliencePolicyCreate,
} from '@maestro/shared';
import type { Bus } from './../bus.ts';
import type { MaestroConfig } from './../config.ts';
import type { Store } from './../db.ts';
import { makeId, nowIso } from './../util.ts';
import type { ProviderAdapter } from './adapter.ts';
import { CliAdapter } from './cli.ts';
import { createProfileDir, loginCommand, probeClaude, readAuthStatus } from './claude.ts';
import { HttpApiAdapter } from './http-api.ts';
import { FAILURE_LABELS } from './failure.ts';
import { availability, type ResolvedTarget } from './policy.ts';

/**
 * Pénitence appliquée quand un quota tombe sans réouverture annoncée.
 *
 * Ni trop court (on remartèlerait un compte épuisé), ni trop long (on
 * s'interdirait un compte redevenu disponible). Une demi-heure est un
 * compromis, pas une vérité — d'où la constante nommée plutôt qu'un littéral
 * perdu dans une expression.
 */
const BLIND_QUOTA_COOLDOWN_MS = 30 * 60 * 1000;
/** Pénitence par défaut d'une saturation ponctuelle sans `retry-after`. */
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

export class ProviderService {
  private adapters = new Map<ProviderKind, ProviderAdapter>([
    ['codex-cli', new CliAdapter('codex-cli')],
    ['opencode-cli', new CliAdapter('opencode-cli')],
    ['http-api', new HttpApiAdapter()],
  ]);

  constructor(
    private store: Store,
    private bus: Bus,
    private config: MaestroConfig,
  ) {}

  /**
   * Adaptateur d'un fournisseur externe.
   *
   * `claude-sdk` rend `undefined` : son exécution vit dans `runs.ts`, tissée
   * avec les serveurs MCP et le broker d'approbations. L'appelant doit traiter
   * ce cas, et c'est plus honnête qu'un adaptateur factice qui échouerait à
   * l'exécution.
   */
  adapterFor(kind: ProviderKind): ProviderAdapter | undefined {
    return this.adapters.get(kind);
  }

  // -- Comptes ---------------------------------------------------------------

  listAccounts(): ProviderAccount[] {
    return this.store.listProviderAccounts();
  }

  getAccount(id: string): ProviderAccount | null {
    return this.store.getProviderAccount(id);
  }

  createAccount(input: ProviderAccountCreate): ProviderAccount {
    const now = nowIso();
    const account: ProviderAccount = {
      ...input,
      id: makeId('acc'),
      health: 'unknown',
      cooldownUntil: null,
      lastError: null,
      lastCheckedAt: null,
      detail: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertProviderAccount(account);
    this.bus.publish({ type: 'provider.updated', payload: account });
    this.bus.log('info', 'providers', `Compte « ${account.name} » créé (${account.kind})`);
    return account;
  }

  updateAccount(id: string, patch: Partial<ProviderAccountCreate>): ProviderAccount | null {
    const current = this.store.getProviderAccount(id);
    if (!current) return null;
    const updated: ProviderAccount = { ...current, ...patch, id, updatedAt: nowIso() };
    /* Réactiver un compte le sort de pénitence : l'opérateur qui rallume un
       compte affirme qu'il est utilisable, et attendre la fin d'un cooldown
       hérité d'un incident passé n'aurait aucun sens. */
    if (patch.enabled === true && !current.enabled) {
      updated.health = 'unknown';
      updated.cooldownUntil = null;
      updated.lastError = null;
    }
    if (patch.enabled === false) updated.health = 'disabled';
    this.store.updateProviderAccount(updated);
    this.bus.publish({ type: 'provider.updated', payload: updated });
    return updated;
  }

  deleteAccount(id: string): boolean {
    const account = this.store.getProviderAccount(id);
    if (!account) return false;
    const detached = this.store.detachAccountFromPolicies(id);
    this.store.deleteProviderAccount(id);
    this.bus.publish({ type: 'provider.deleted', payload: { id } });
    this.bus.log(
      'warn',
      'providers',
      `Compte « ${account.name} » supprimé${detached > 0 ? ` — retiré de ${detached} politique(s)` : ''}`,
    );
    return true;
  }

  /**
   * Crée le répertoire d'un profil d'abonnement et rend la commande de
   * connexion. L'authentification reste manuelle : elle ouvre un navigateur.
   */
  prepareProfile(slug: string): { configDir: string; command: string } {
    const configDir = createProfileDir(this.config.dataDir, slug);
    return { configDir, command: loginCommand(configDir) };
  }

  // -- Santé -----------------------------------------------------------------

  /**
   * Marque un compte disponible.
   *
   * Appelé après chaque tentative réussie : c'est ce qui fait sortir de
   * pénitence un compte dont le quota s'est effectivement rouvert, sans
   * qu'aucune minuterie n'ait eu à le surveiller.
   */
  markSuccess(accountId: string | null): void {
    if (!accountId) return;
    const account = this.store.getProviderAccount(accountId);
    if (!account || !account.enabled) return;
    if (account.health === 'ready' && !account.cooldownUntil) return;
    const updated: ProviderAccount = {
      ...account,
      health: 'ready',
      cooldownUntil: null,
      lastError: null,
      lastCheckedAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.store.updateProviderAccount(updated);
    this.bus.publish({ type: 'provider.updated', payload: updated });
  }

  /**
   * Applique le verdict d'un échec au compte concerné.
   *
   * Le compte ne devient indisponible que si le verdict le dit
   * (`poisonsAccount`) : une erreur applicative ou une surcharge passagère du
   * fournisseur ne condamne pas un compte, et le marquer en panne priverait le
   * routeur d'une cible parfaitement valide.
   */
  markFailure(accountId: string | null, verdict: FailureVerdict, nowMs = Date.now()): void {
    if (!accountId) return;
    const account = this.store.getProviderAccount(accountId);
    if (!account) return;
    if (!verdict.poisonsAccount) return;

    let health: ProviderAccount['health'] = account.health;
    let cooldownUntil: string | null = null;

    if (verdict.klass === 'auth') {
      health = 'unauthenticated';
    } else if (verdict.klass === 'quota') {
      health = 'exhausted';
      cooldownUntil = new Date(
        nowMs + (verdict.retryAfterMs ?? BLIND_QUOTA_COOLDOWN_MS),
      ).toISOString();
    } else if (verdict.klass === 'rate_limit') {
      health = 'cooldown';
      cooldownUntil = new Date(
        nowMs + (verdict.retryAfterMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS),
      ).toISOString();
    } else {
      health = 'error';
    }

    const updated: ProviderAccount = {
      ...account,
      health,
      cooldownUntil,
      lastError: `${FAILURE_LABELS[verdict.klass]} — ${verdict.message}`,
      lastCheckedAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.store.updateProviderAccount(updated);
    this.bus.publish({ type: 'provider.updated', payload: updated });
    this.bus.log(
      'warn',
      'providers',
      `Compte « ${account.name} » : ${FAILURE_LABELS[verdict.klass]}` +
        (cooldownUntil ? ` — indisponible jusqu'à ${cooldownUntil}` : ''),
    );
  }

  /**
   * Vérifie le plafond de dépense quotidien d'un compte.
   *
   * Contrôlé à la sélection et non après coup : un plafond qu'on ne constate
   * qu'une fois dépassé ne protège de rien.
   */
  overDailyBudget(account: ProviderAccount, nowIsoStr = nowIso()): boolean {
    if (!account.dailyCostLimitUsd || account.dailyCostLimitUsd <= 0) return false;
    const day = nowIsoStr.slice(0, 10);
    return this.store.accountCostToday(account.id, day) >= account.dailyCostLimitUsd;
  }

  // -- Politiques ------------------------------------------------------------

  listPolicies(): ResiliencePolicy[] {
    return this.store.listResiliencePolicies();
  }

  getPolicy(id: string): ResiliencePolicy | null {
    return this.store.getResiliencePolicy(id);
  }

  createPolicy(input: ResiliencePolicyCreate): ResiliencePolicy {
    const now = nowIso();
    const policy: ResiliencePolicy = {
      ...input,
      id: makeId('pol'),
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertResiliencePolicy(policy);
    this.bus.publish({ type: 'policy.updated', payload: policy });
    return policy;
  }

  updatePolicy(id: string, patch: Partial<ResiliencePolicyCreate>): ResiliencePolicy | null {
    const current = this.store.getResiliencePolicy(id);
    if (!current) return null;
    const updated: ResiliencePolicy = { ...current, ...patch, id, updatedAt: nowIso() };
    this.store.updateResiliencePolicy(updated);
    this.bus.publish({ type: 'policy.updated', payload: updated });
    return updated;
  }

  deletePolicy(id: string): boolean {
    if (!this.store.getResiliencePolicy(id)) return false;
    this.store.deleteResiliencePolicy(id);
    this.bus.publish({ type: 'policy.deleted', payload: { id } });
    return true;
  }

  /**
   * Politique effective d'un run : celle de l'étape, sinon celle de l'agent,
   * sinon celle de l'instance. `null` = comportement historique, environnement
   * ambiant et aucun repli.
   */
  effectivePolicy(agent: AgentConfig, override?: string | null): ResiliencePolicy | null {
    const id =
      override ?? agent.resiliencePolicyId ?? this.store.getSettings().defaultResiliencePolicyId;
    return id ? this.store.getResiliencePolicy(id) : null;
  }

  /**
   * Résout les cibles d'une politique en comptes réels.
   *
   * Les cibles orphelines (compte supprimé) sont ignorées **et signalées** :
   * une politique qui rétrécit en silence ferait croire à un repli qui
   * n'existe plus.
   */
  resolveTargets(policy: ResiliencePolicy): ResolvedTarget[] {
    const resolved: ResolvedTarget[] = [];
    let missing = 0;
    policy.targets.forEach((target) => {
      const account = this.store.getProviderAccount(target.accountId);
      if (!account) {
        missing++;
        return;
      }
      resolved.push({ target, account, index: resolved.length });
    });
    if (missing > 0) {
      this.bus.log(
        'warn',
        'providers',
        `Politique « ${policy.name} » : ${missing} compte(s) introuvable(s), ignoré(s)`,
      );
    }
    return resolved;
  }

  /**
   * Écarte les cibles hors budget quotidien avant même de tenter.
   *
   * Renvoie la liste réindexée : les index servent au routeur pour repérer la
   * cible courante, ils doivent rester cohérents avec le tableau rendu.
   */
  withinBudget(targets: ResolvedTarget[]): ResolvedTarget[] {
    const day = nowIso();
    return targets
      .filter((t) => {
        if (!this.overDailyBudget(t.account, day)) return true;
        this.bus.log(
          'warn',
          'providers',
          `Compte « ${t.account.name} » écarté : plafond quotidien de $${t.account.dailyCostLimitUsd} atteint`,
        );
        return false;
      })
      .map((t, index) => ({ ...t, index }));
  }

  // -- Environnement d'exécution ---------------------------------------------

  /**
   * Environnement d'un processus de tentative.
   *
   * Le compte n'apporte que ce qui l'identifie : un répertoire de
   * configuration, ou la présence d'une clé déjà dans l'environnement du
   * serveur. Rien n'est lu depuis la base — la base ne contient aucun secret,
   * et c'est ce qui rend cette fonction sûre.
   */
  envForAccount(account: ProviderAccount | null): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (!account) return env;

    if (account.authMode === 'profile' && account.configDir) {
      env.CLAUDE_CONFIG_DIR = account.configDir;
      /* Un profil d'abonnement et une clé d'API héritée du serveur se
         disputeraient l'authentification. Retirer la clé garantit que le
         profil est bien celui qui paie — c'est tout l'intérêt du multi-comptes. */
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
    }

    if (account.authMode === 'api-key-env' && account.apiKeyEnv) {
      const value = process.env[account.apiKeyEnv];
      if (value) {
        /* La variable canonique attendue par les outils Anthropic, alimentée
           depuis celle que l'opérateur a choisie. Deux comptes peuvent ainsi
           coexister dans un même serveur. */
        if (account.kind === 'claude-sdk' || account.apiFlavor === 'anthropic') {
          env.ANTHROPIC_API_KEY = value;
          delete env.CLAUDE_CONFIG_DIR;
        }
        env[account.apiKeyEnv] = value;
      }
    }

    if (account.baseUrl && account.kind === 'claude-sdk') {
      env.ANTHROPIC_BASE_URL = account.baseUrl;
    }

    for (const [key, value] of Object.entries(account.env ?? {})) {
      env[key] = value;
    }
    return env;
  }

  // -- Sondes ----------------------------------------------------------------

  /** Sonde tous les fournisseurs connus — base de l'assistant de configuration. */
  async probeAll(): Promise<ProviderProbe[]> {
    const probes: ProviderProbe[] = [];
    for (const kind of PROVIDER_KINDS) {
      probes.push(await this.probe(kind));
    }
    return probes;
  }

  async probe(kind: ProviderKind, account?: ProviderAccount | null): Promise<ProviderProbe> {
    if (kind === 'claude-sdk') return await probeClaude(this.config.dataDir);
    const adapter = this.adapters.get(kind);
    if (!adapter) {
      return {
        kind,
        label: PROVIDER_LABELS[kind],
        binaryPath: null,
        version: null,
        detectedProfiles: [],
        envCandidates: [],
        ready: false,
        hint: 'Fournisseur inconnu',
        invocation: null,
        invocationDegraded: false,
      };
    }
    return await adapter.probe(account ?? null);
  }

  /**
   * Teste un compte et met sa santé à jour.
   *
   * Le test est volontairement léger — présence du binaire, authentification,
   * variable définie — et n'envoie **aucune requête facturable**. Un bouton
   * « tester » qui consomme du quota serait une mauvaise surprise.
   */
  async testAccount(id: string): Promise<ProviderAccount | null> {
    const account = this.store.getProviderAccount(id);
    if (!account) return null;

    let health: ProviderAccount['health'] = 'ready';
    let detail: string | null = null;
    let lastError: string | null = null;

    if (!account.enabled) {
      health = 'disabled';
      detail = 'compte désactivé';
    } else if (account.kind === 'claude-sdk' && account.authMode === 'profile') {
      const status = await readAuthStatus(account.configDir);
      if (!status) {
        health = 'error';
        lastError = 'claude auth status n’a pas répondu';
      } else if (!status.loggedIn) {
        health = 'unauthenticated';
        lastError = 'profil non authentifié';
        detail = account.configDir ? `à connecter : ${loginCommand(account.configDir)}` : null;
      } else {
        detail = [status.subscriptionType, status.account].filter(Boolean).join(' — ') || null;
      }
    } else if (account.authMode === 'api-key-env') {
      if (!account.apiKeyEnv || !process.env[account.apiKeyEnv]) {
        health = 'unauthenticated';
        lastError = `variable ${account.apiKeyEnv ?? '(non définie)'} absente de l’environnement du serveur`;
      } else {
        detail = `clé lue depuis ${account.apiKeyEnv}`;
      }
    } else if (account.kind === 'codex-cli' || account.kind === 'opencode-cli') {
      const probe = await this.probe(account.kind, account);
      if (!probe.binaryPath) {
        health = 'error';
        lastError = probe.hint;
      } else {
        detail = [probe.version, probe.binaryPath].filter(Boolean).join(' — ');
      }
    }

    if (health === 'ready' && !PROVIDER_CAPABILITIES[account.kind].interceptsPermissions) {
      detail = `${detail ? `${detail} — ` : ''}permissions non interceptées`;
    }

    const updated: ProviderAccount = {
      ...account,
      health,
      cooldownUntil: health === 'ready' ? null : account.cooldownUntil,
      lastError,
      detail,
      lastCheckedAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.store.updateProviderAccount(updated);
    this.bus.publish({ type: 'provider.updated', payload: updated });
    return updated;
  }

  /**
   * Comptes proposés à partir de ce que la machine expose déjà.
   *
   * Rien n'est créé automatiquement : proposer laisse le choix, créer
   * imposerait une configuration que l'opérateur n'a pas demandée.
   */
  async suggestAccounts(): Promise<ProviderAccountCreate[]> {
    const suggestions: ProviderAccountCreate[] = [];
    const existing = this.store.listProviderAccounts();
    const known = new Set(
      existing.map((a) => `${a.kind}:${a.configDir ?? a.apiKeyEnv ?? a.baseUrl ?? ''}`),
    );
    let priority = 10;

    const claude = await probeClaude(this.config.dataDir);
    for (const profile of claude.detectedProfiles) {
      if (!profile.loggedIn) continue;
      const configDir = profile.configDir === '(défaut)' ? null : profile.configDir;
      if (known.has(`claude-sdk:${configDir ?? ''}`)) continue;
      suggestions.push({
        ...emptyAccount('claude-sdk'),
        name: profile.account
          ? `Claude — ${profile.account}`
          : configDir
            ? `Claude — ${configDir.split('/').pop()}`
            : 'Claude — profil par défaut',
        authMode: configDir ? 'profile' : 'inherit',
        configDir,
        priority: (priority += 10),
      });
    }

    for (const name of claude.envCandidates) {
      if (known.has(`claude-sdk:${name}`)) continue;
      suggestions.push({
        ...emptyAccount('claude-sdk'),
        name: `Claude — clé ${name}`,
        authMode: 'api-key-env',
        apiKeyEnv: name,
        priority: (priority += 10),
      });
    }

    for (const kind of ['codex-cli', 'opencode-cli'] as const) {
      const probe = await this.probe(kind);
      if (!probe.binaryPath || known.has(`${kind}:`)) continue;
      const defaults = CLI_DEFAULTS[kind];
      suggestions.push({
        ...emptyAccount(kind),
        name: PROVIDER_LABELS[kind],
        authMode: 'inherit',
        command: defaults?.command ?? null,
        /* `null` = détection au lancement, à partir de l'aide du binaire
           installé. Figer ici une suite d'arguments la gèlerait à la version du
           jour, et obligerait l'utilisateur à la corriger à la main plus tard. */
        args: null,
        priority: (priority += 10),
      });
    }

    return suggestions;
  }

  /** Comptes utilisables tout de suite, pour choisir un moteur de résumé. */
  readyAccounts(nowMs = Date.now()): ProviderAccount[] {
    return this.store
      .listProviderAccounts()
      .filter((a) => availability(a, nowMs).state === 'ready')
      .sort((a, b) => a.priority - b.priority);
  }
}

/** Compte vierge d'un type donné — évite d'oublier un champ à chaque création. */
export function emptyAccount(kind: ProviderKind): ProviderAccountCreate {
  return {
    name: PROVIDER_LABELS[kind],
    kind,
    enabled: true,
    authMode: 'inherit',
    configDir: null,
    apiKeyEnv: null,
    baseUrl: kind === 'http-api' ? API_BASE_URLS.anthropic : null,
    apiFlavor: kind === 'http-api' ? 'anthropic' : null,
    model: null,
    command: null,
    args: null,
    env: {},
    priority: 100,
    dailyCostLimitUsd: null,
  };
}
