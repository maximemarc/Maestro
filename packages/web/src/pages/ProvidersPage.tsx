/**
 * Page Fournisseurs : comptes d'exécution, politiques de repli, et assistant
 * de première configuration.
 *
 * Le fil conducteur de l'écran est une question : « si ce compte tombe, que se
 * passe-t-il ? ». D'où l'ordre — ce que la machine sait faire, les comptes
 * déclarés avec leur santé, puis les politiques qui les ordonnent. Une page qui
 * commencerait par les politiques demanderait de choisir un ordre entre des
 * comptes qui n'existent pas encore.
 *
 * 🔒 Aucune valeur de secret ne passe par ce formulaire : on saisit le **nom**
 * de la variable d'environnement du serveur, jamais la clé.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowsClockwise,
  CheckCircle,
  Detective,
  Plus,
  ShieldWarning,
  Stack,
  Timer,
  UserCircle,
  Warning,
} from '@phosphor-icons/react';
import {
  API_BASE_URLS,
  CLI_DEFAULTS,
  PROVIDER_CAPABILITIES,
  PROVIDER_KINDS,
  PROVIDER_LABELS,
  type AccountUsage,
  type ProviderAccount,
  type ProviderAccountCreate,
  type ProviderHealth,
  type ProviderKind,
  type ProviderProbe,
  type ResiliencePolicy,
  type ResiliencePolicyCreate,
} from '@maestro/shared';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { ConfirmButton, EmptyState, ErrorText, Field, Modal, Spinner } from '../components/ui';

const HEALTH_LABELS: Record<ProviderHealth, string> = {
  unknown: 'jamais testé',
  ready: 'disponible',
  cooldown: 'en pause',
  exhausted: 'quota épuisé',
  unauthenticated: 'non authentifié',
  error: 'en erreur',
  disabled: 'désactivé',
};

const HEALTH_TONE: Record<ProviderHealth, string> = {
  unknown: 'muted',
  ready: 'ok',
  cooldown: 'warn',
  exhausted: 'warn',
  unauthenticated: 'danger',
  error: 'danger',
  disabled: 'muted',
};

function blankAccount(kind: ProviderKind): ProviderAccountCreate {
  const cli = CLI_DEFAULTS[kind];
  return {
    name: PROVIDER_LABELS[kind],
    kind,
    enabled: true,
    authMode: kind === 'http-api' ? 'api-key-env' : 'inherit',
    configDir: null,
    apiKeyEnv: null,
    baseUrl: kind === 'http-api' ? API_BASE_URLS.anthropic : null,
    apiFlavor: kind === 'http-api' ? 'anthropic' : null,
    model: null,
    command: cli?.command ?? null,
    /* Vide = déduit de l'aide du binaire installé au moment du run. Proposer
       une suite d'arguments toute faite reviendrait à parier sur une version. */
    args: null,
    env: {},
    priority: 100,
    dailyCostLimitUsd: null,
    // Cinq heures : la fenêtre de session des abonnements Claude.
    usageWindowSec: 5 * 60 * 60,
    windowTokenLimit: null,
  };
}

function toForm(account: ProviderAccount): ProviderAccountCreate {
  const {
    id: _id,
    health: _h,
    cooldownUntil: _c,
    lastError: _e,
    lastCheckedAt: _l,
    detail: _d,
    learnedTokenLimit: _lt,
    learnedAt: _la,
    createdAt: _cr,
    updatedAt: _u,
    ...rest
  } = account;
  return rest;
}

/** Tokens en notation courte : 1 240 000 se lit mal dans une jauge. */
function fmtTokensShort(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)} k`;
  return String(value);
}

function fmtWindow(sec: number): string {
  const hours = sec / 3600;
  return hours >= 1 ? `${Math.round(hours)} h` : `${Math.round(sec / 60)} min`;
}

function blankPolicy(): ResiliencePolicyCreate {
  return {
    name: '',
    description: '',
    targets: [],
    maxAttemptsPerTarget: 2,
    maxTotalAttempts: 4,
    backoffInitialMs: 2000,
    backoffFactor: 3,
    backoffMaxMs: 60_000,
    backoffJitter: true,
    quotaWaitMaxSec: 900,
    switchOnError: true,
    handoffThresholdPct: 80,
    quotaPressurePct: 85,
  };
}

export default function ProvidersPage() {
  const accounts = useStore((s) => s.accounts);
  const policies = useStore((s) => s.policies);
  const notify = useStore((s) => s.notify);

  const [probes, setProbes] = useState<ProviderProbe[] | null>(null);
  const [usage, setUsage] = useState<AccountUsage[]>([]);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountForm, setAccountForm] = useState<{
    id: string | null;
    draft: ProviderAccountCreate;
  } | null>(null);
  const [policyForm, setPolicyForm] = useState<{
    id: string | null;
    draft: ResiliencePolicyCreate;
  } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const probe = useCallback(async () => {
    setProbing(true);
    setError(null);
    try {
      setProbes(await api.probeProviders());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sonde impossible');
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  /*
   * La consommation est relue périodiquement : elle bouge pendant qu'un run
   * tourne, et une jauge figée sur l'état d'ouverture de la page induirait en
   * erreur au moment où elle compte le plus.
   */
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api
        .providersUsage()
        .then((list) => {
          if (!cancelled) setUsage(list);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [accounts.length]);

  const saveAccount = async () => {
    if (!accountForm) return;
    try {
      if (accountForm.id) await api.updateAccount(accountForm.id, accountForm.draft);
      else await api.createAccount(accountForm.draft);
      setAccountForm(null);
      notify('Compte enregistré');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Enregistrement impossible');
    }
  };

  const savePolicy = async () => {
    if (!policyForm) return;
    try {
      if (policyForm.id) await api.updatePolicy(policyForm.id, policyForm.draft);
      else await api.createPolicy(policyForm.draft);
      setPolicyForm(null);
      notify('Politique enregistrée');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Enregistrement impossible');
    }
  };

  const test = async (id: string) => {
    setTesting(id);
    try {
      const account = await api.testAccount(id);
      notify(
        account.health === 'ready'
          ? `« ${account.name} » est disponible`
          : `« ${account.name} » : ${HEALTH_LABELS[account.health]}`,
        account.health === 'ready' ? 'ok' : 'info',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test impossible');
    } finally {
      setTesting(null);
    }
  };

  const adopt = async (suggestion: ProviderAccountCreate) => {
    try {
      await api.createAccount(suggestion);
      notify(`Compte « ${suggestion.name} » ajouté`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ajout impossible');
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Fournisseurs</h1>
        <span className="spacer" />
        <button className="btn" onClick={() => void probe()} disabled={probing}>
          {probing ? <Spinner /> : <ArrowsClockwise />}
          Sonder la machine
        </button>
        <button
          className="btn"
          onClick={() => setPolicyForm({ id: null, draft: blankPolicy() })}
          disabled={accounts.length === 0}
        >
          <Stack />
          Nouvelle politique
        </button>
        <button
          className="btn primary"
          onClick={() => setAccountForm({ id: null, draft: blankAccount('claude-sdk') })}
        >
          <Plus />
          Ajouter un compte
        </button>
      </div>
      <p className="page-lede">
        Un compte est une identité d’exécution : un profil d’abonnement Claude, une clé d’API, un
        CLI tiers. Une politique ordonne ces comptes et décide de la suite quand l’un tombe —
        réessayer, attendre la réouverture d’un quota, ou basculer sur le suivant. Un agent sans
        politique s’exécute comme avant, sur l’environnement du serveur, sans repli.
      </p>

      {error && <ErrorText>{error}</ErrorText>}

      <OnboardingBanner accounts={accounts.length} policies={policies.length} />

      <section className="mt-4">
        <h2>Ce que cette machine sait faire</h2>
        <div className="col gap-3 mt-3">
          {probes === null ? (
            <Spinner />
          ) : (
            probes.map((p) => (
              <ProbeCard
                key={p.kind}
                probe={p}
                onAdd={() => setAccountForm({ id: null, draft: blankAccount(p.kind) })}
              />
            ))
          )}
        </div>
      </section>

      <SuggestionList accounts={accounts} onAdopt={adopt} />

      <section className="mt-4">
        <h2>Comptes</h2>
        {accounts.length === 0 ? (
          <EmptyState
            icon={<UserCircle size={28} />}
            title="Aucun compte déclaré"
            hint="Sans compte, Maestro exécute les runs sur l’environnement du serveur — un seul quota, aucun repli."
          >
            <button
              className="btn primary"
              onClick={() => setAccountForm({ id: null, draft: blankAccount('claude-sdk') })}
            >
              <Plus />
              Ajouter un compte
            </button>
          </EmptyState>
        ) : (
          <div className="col gap-3 mt-3">
            {accounts.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                usage={usage.find((u) => u.accountId === account.id)}
                testing={testing === account.id}
                onTest={() => void test(account.id)}
                onEdit={() => setAccountForm({ id: account.id, draft: toForm(account) })}
                onRemove={() => void api.deleteAccount(account.id)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="mt-4">
        <h2>Politiques de résilience</h2>
        {policies.length === 0 ? (
          <EmptyState
            icon={<Stack size={28} />}
            title="Aucune politique"
            hint="Une politique donne l’ordre des comptes à essayer. Sans elle, un quota atteint arrête le run."
            compact
          />
        ) : (
          <div className="col gap-3 mt-3">
            {policies.map((policy) => (
              <PolicyCard
                key={policy.id}
                policy={policy}
                accounts={accounts}
                onEdit={() =>
                  setPolicyForm({
                    id: policy.id,
                    draft: { ...policy } as unknown as ResiliencePolicyCreate,
                  })
                }
                onRemove={() => void api.deletePolicy(policy.id)}
              />
            ))}
          </div>
        )}
      </section>

      {accountForm && (
        <AccountModal
          form={accountForm}
          probes={probes}
          onChange={(draft) => setAccountForm({ ...accountForm, draft })}
          onClose={() => setAccountForm(null)}
          onSave={() => void saveAccount()}
        />
      )}

      {policyForm && (
        <PolicyModal
          form={policyForm}
          accounts={accounts}
          onChange={(draft) => setPolicyForm({ ...policyForm, draft })}
          onClose={() => setPolicyForm(null)}
          onSave={() => void savePolicy()}
        />
      )}
    </div>
  );
}

/**
 * Assistant de première configuration.
 *
 * Volontairement un bandeau et non un parcours modal bloquant : Maestro
 * fonctionne sans comptes, la configuration multi-fournisseurs est une
 * amélioration, pas un prérequis. Un assistant qui barrerait l'écran au premier
 * lancement ferait payer à tout le monde le prix d'une fonctionnalité que
 * certains n'utiliseront jamais.
 */
function OnboardingBanner({ accounts, policies }: { accounts: number; policies: number }) {
  const [dismissed, setDismissed] = useState(false);
  const [completed, setCompleted] = useState<boolean | null>(null);

  useEffect(() => {
    void api
      .getOnboarding()
      .then((r) => setCompleted(r.state.completed))
      .catch(() => setCompleted(true));
  }, []);

  if (completed !== false || dismissed) return null;

  const steps = [
    { done: accounts > 0, label: 'Déclarer au moins un compte' },
    { done: accounts > 1, label: 'En déclarer un second — c’est lui qui prend le relais' },
    { done: policies > 0, label: 'Créer une politique qui les ordonne' },
  ];

  const finish = () => {
    setDismissed(true);
    void api.patchOnboarding({ completed: true }).catch(() => undefined);
  };

  return (
    <section className="card mt-4">
      <div className="row gap-2 items-center">
        <Detective size={20} />
        <strong>Premiers pas</strong>
        <span className="spacer" />
        <button className="btn sm" onClick={finish}>
          Ne plus afficher
        </button>
      </div>
      <p className="hint mt-2">
        Trois étapes pour qu’un quota atteint cesse d’arrêter un run. Rien n’est obligatoire :
        Maestro fonctionne sans, avec un seul compte et aucun repli.
      </p>
      <ul className="col gap-1 mt-2">
        {steps.map((step) => (
          <li key={step.label} className="row gap-2 items-center">
            {step.done ? <CheckCircle weight="fill" /> : <Timer />}
            <span className={step.done ? 'muted' : ''}>{step.label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ProbeCard({ probe, onAdd }: { probe: ProviderProbe; onAdd: () => void }) {
  const caps = PROVIDER_CAPABILITIES[probe.kind];
  const loggedIn = probe.detectedProfiles.filter((p) => p.loggedIn);
  return (
    <div className="card">
      <div className="row gap-2 items-center">
        <strong>{probe.label}</strong>
        <span className={`badge ${probe.ready ? 'ok' : 'muted'}`}>
          {probe.ready ? 'disponible' : 'indisponible'}
        </span>
        {probe.version && <span className="muted mono sm">{probe.version}</span>}
        <span className="spacer" />
        <button className="btn sm" onClick={onAdd}>
          <Plus />
          Déclarer un compte
        </button>
      </div>
      {probe.hint && <p className="hint mt-2">{probe.hint}</p>}
      {probe.invocation && (
        <p className={`hint mt-2${probe.invocationDegraded ? ' warn' : ''}`}>
          {probe.invocationDegraded ? <Warning /> : null} Invocation déduite :{' '}
          <span className="mono">
            {[
              /* Le binaire est affiché avec ses arguments : c'est la commande
                 réelle que l'opérateur pourrait rejouer dans un terminal. */
              probe.binaryPath?.split('/').pop(),
              ...probe.invocation.map((a) => (a === '{{prompt}}' ? '<prompt>' : a)),
            ].join(' ')}
          </span>
        </p>
      )}
      {loggedIn.length > 0 && (
        <p className="hint mt-2">
          {loggedIn.length} profil(s) authentifié(s) :{' '}
          {loggedIn.map((p) => p.account ?? p.configDir).join(', ')}
        </p>
      )}
      {probe.envCandidates.length > 0 && (
        <p className="hint mt-2">
          Variables d’environnement présentes :{' '}
          <span className="mono">{probe.envCandidates.join(', ')}</span> — seuls les noms sont lus,
          jamais les valeurs.
        </p>
      )}
      {!caps.interceptsPermissions && (
        <p className="hint warn mt-2">
          <ShieldWarning /> Les permissions ne sont pas interceptées sur ce moteur : la politique
          d’approbation d’un agent y devient déclarative.
        </p>
      )}
    </div>
  );
}

/** Comptes déduits de la machine, à confirmer un par un. */
function SuggestionList({
  accounts,
  onAdopt,
}: {
  accounts: ProviderAccount[];
  onAdopt: (s: ProviderAccountCreate) => Promise<void>;
}) {
  const [suggestions, setSuggestions] = useState<ProviderAccountCreate[]>([]);

  useEffect(() => {
    void api
      .accountSuggestions()
      .then(setSuggestions)
      .catch(() => setSuggestions([]));
  }, [accounts.length]);

  if (suggestions.length === 0) return null;

  return (
    <section className="mt-4">
      <h2>Comptes détectés</h2>
      <p className="hint mt-1">
        Trouvés sur cette machine, pas encore déclarés. Rien n’est créé sans ton accord.
      </p>
      <div className="col gap-2 mt-3">
        {suggestions.map((s) => (
          <div
            className="card row gap-2 items-center"
            key={`${s.kind}:${s.configDir ?? s.apiKeyEnv ?? s.name}`}
          >
            <span className="badge">{PROVIDER_LABELS[s.kind]}</span>
            <strong>{s.name}</strong>
            <span className="muted sm">
              {s.authMode === 'profile'
                ? 'profil d’abonnement'
                : s.authMode === 'api-key-env'
                  ? `clé ${s.apiKeyEnv}`
                  : 'environnement du serveur'}
            </span>
            <span className="spacer" />
            <button className="btn sm primary" onClick={() => void onAdopt(s)}>
              <Plus />
              Ajouter
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Consommation d'un compte sur sa fenêtre.
 *
 * Trois cas à distinguer nettement, parce qu'ils appellent des réactions
 * différentes : on mesure et on connaît le plafond (jauge), on mesure sans
 * connaître le plafond (chiffre brut, aucune conclusion), on ne sait pas
 * mesurer (le dire). Afficher une jauge vide dans le dernier cas ferait passer
 * un angle mort pour un compte au repos.
 */
function UsageGauge({ usage }: { usage: AccountUsage | undefined }) {
  if (!usage) return null;

  if (usage.source === 'unavailable') {
    return (
      <p className="hint mt-2">
        Consommation non mesurable sur ce moteur : il ne rapporte pas ses tokens. L’anticipation de
        quota ne s’applique pas.
      </p>
    );
  }

  const window = fmtWindow(usage.windowSec);
  const consumed = `${fmtTokensShort(usage.billableTokens)} tokens sur ${window}`;
  const origin =
    usage.source === 'transcripts'
      ? 'transcripts du profil, sessions hors Maestro comprises'
      : 'tentatives lancées par Maestro';

  if (usage.pressure === null) {
    return (
      <p className="hint mt-2">
        {consumed} — {origin}. Aucun plafond connu : Maestro l’apprendra à la première limite
        atteinte, ou déclare-le sur le compte.
      </p>
    );
  }

  const pct = Math.min(100, Math.round(usage.pressure * 100));
  const tone = pct >= 85 ? 'warn' : pct >= 60 ? '' : 'ok';
  return (
    <div className="mt-2">
      <div className="row gap-2 items-center">
        <span className={`badge ${tone}`}>{pct} %</span>
        <span className="hint">
          {consumed} sur {fmtTokensShort(usage.limitTokens ?? 0)}
          {usage.limitLearned ? ' (plafond estimé d’après la dernière limite atteinte)' : ''}
        </span>
      </div>
      <div
        className="meter mt-1"
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Consommation de la fenêtre"
      >
        <div className={`meter-fill ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function AccountCard(props: {
  account: ProviderAccount;
  usage: AccountUsage | undefined;
  testing: boolean;
  onTest: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { account } = props;
  const caps = PROVIDER_CAPABILITIES[account.kind];
  return (
    <div className="card">
      <div className="row gap-2 items-center">
        <span className="badge">{PROVIDER_LABELS[account.kind]}</span>
        <strong>{account.name}</strong>
        <span className={`badge ${HEALTH_TONE[account.health]}`}>
          {HEALTH_LABELS[account.health]}
        </span>
        {account.cooldownUntil && account.health !== 'ready' && (
          <span className="muted sm">
            jusqu’à {new Date(account.cooldownUntil).toLocaleTimeString('fr-FR')}
          </span>
        )}
        <span className="spacer" />
        <span className="muted sm">priorité {account.priority}</span>
        <button className="btn sm" onClick={props.onTest} disabled={props.testing}>
          {props.testing ? <Spinner /> : <CheckCircle />}
          Tester
        </button>
        <button className="btn sm" onClick={props.onEdit}>
          Modifier
        </button>
        <ConfirmButton
          label="Supprimer"
          message="Le compte est retiré de toutes les politiques qui le citaient."
          onConfirm={props.onRemove}
        />
      </div>
      <p className="hint mt-2">
        {account.authMode === 'profile'
          ? `Profil : ${account.configDir}`
          : account.authMode === 'api-key-env'
            ? `Clé lue dans ${account.apiKeyEnv}`
            : 'Environnement du serveur'}
        {account.model ? ` — modèle imposé ${account.model}` : ''}
        {account.dailyCostLimitUsd ? ` — plafond $${account.dailyCostLimitUsd}/jour` : ''}
      </p>
      <UsageGauge usage={props.usage} />
      {account.detail && <p className="hint">{account.detail}</p>}
      {account.lastError && <p className="hint warn">{account.lastError}</p>}
      {!caps.interceptsPermissions && (
        <p className="hint warn">
          <ShieldWarning /> Permissions non interceptées.
          {!caps.editsWorkspace && ' Ce fournisseur ne modifie pas le workspace.'}
        </p>
      )}
    </div>
  );
}

function PolicyCard(props: {
  policy: ResiliencePolicy;
  accounts: ProviderAccount[];
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { policy, accounts } = props;
  const chain = useMemo(
    () =>
      policy.targets.map((t) => {
        const account = accounts.find((a) => a.id === t.accountId);
        return account ? `${account.name}${t.model ? ` (${t.model})` : ''}` : '⚠ compte supprimé';
      }),
    [policy.targets, accounts],
  );

  return (
    <div className="card">
      <div className="row gap-2 items-center">
        <strong>{policy.name}</strong>
        <span className="spacer" />
        <button className="btn sm" onClick={props.onEdit}>
          Modifier
        </button>
        <ConfirmButton label="Supprimer" onConfirm={props.onRemove} />
      </div>
      {policy.description && <p className="hint mt-2">{policy.description}</p>}
      <p className="hint mt-2">
        {chain.length === 0 ? (
          <span className="warn">
            <Warning /> Aucune cible : cette politique n’offre aucun repli.
          </span>
        ) : (
          <>Ordre : {chain.join(' → ')}</>
        )}
      </p>
      <p className="hint">
        {policy.maxAttemptsPerTarget} essai(s) par compte, {policy.maxTotalAttempts} au total —
        attente de quota jusqu’à {Math.round(policy.quotaWaitMaxSec / 60)} min —{' '}
        {policy.switchOnError ? 'bascule sur erreur' : 'pas de bascule sur erreur'} — résumé de
        reprise à {policy.handoffThresholdPct || '—'}
        {policy.handoffThresholdPct ? ' % du budget' : ' (désactivé)'}
      </p>
    </div>
  );
}

function AccountModal(props: {
  form: { id: string | null; draft: ProviderAccountCreate };
  probes: ProviderProbe[] | null;
  onChange: (draft: ProviderAccountCreate) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { draft } = props.form;
  const set = (patch: Partial<ProviderAccountCreate>) => props.onChange({ ...draft, ...patch });
  const probe = props.probes?.find((p) => p.kind === draft.kind) ?? null;
  const [profileHint, setProfileHint] = useState<string | null>(null);

  const prepare = async () => {
    try {
      const { configDir, command } = await api.prepareProfile(draft.name || 'compte');
      set({ authMode: 'profile', configDir });
      setProfileHint(command);
    } catch (err) {
      setProfileHint(err instanceof Error ? err.message : 'Préparation impossible');
    }
  };

  return (
    <Modal
      title={props.form.id ? 'Modifier le compte' : 'Nouveau compte'}
      onClose={props.onClose}
      wide
    >
      <div className="col gap-3">
        <div className="row gap-3">
          <Field label="Nom">
            <input
              className="input"
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>
          <Field label="Fournisseur">
            <select
              className="input"
              value={draft.kind}
              onChange={(e) => {
                const kind = e.target.value as ProviderKind;
                props.onChange({ ...blankAccount(kind), name: draft.name });
              }}
              disabled={props.form.id !== null}
            >
              {PROVIDER_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {PROVIDER_LABELS[kind]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field
          label="Authentification"
          hint="Un profil isole un abonnement dans son propre répertoire de configuration : deux profils = deux quotas."
        >
          <select
            className="input"
            value={draft.authMode}
            onChange={(e) => set({ authMode: e.target.value as ProviderAccountCreate['authMode'] })}
          >
            <option value="inherit">Environnement du serveur</option>
            <option value="profile">Profil dédié (abonnement)</option>
            <option value="api-key-env">Clé d’API par variable d’environnement</option>
          </select>
        </Field>

        {draft.authMode === 'profile' && (
          <Field label="Répertoire de configuration">
            <div className="row gap-2">
              <input
                className="input"
                value={draft.configDir ?? ''}
                placeholder="/home/…/.maestro/accounts/perso"
                onChange={(e) => set({ configDir: e.target.value || null })}
              />
              <button className="btn sm" onClick={() => void prepare()}>
                Préparer
              </button>
            </div>
          </Field>
        )}

        {profileHint && (
          <p className="hint">
            Répertoire prêt. Connecte ce profil depuis un terminal :{' '}
            <span className="mono">{profileHint}</span>
          </p>
        )}

        {draft.authMode === 'api-key-env' && (
          <Field
            label="Nom de la variable d’environnement"
            hint="Le nom seulement. La valeur reste dans l’environnement du serveur : elle n’est ni stockée en base, ni renvoyée à l’interface."
          >
            <input
              className="input mono"
              value={draft.apiKeyEnv ?? ''}
              placeholder="ANTHROPIC_API_KEY_PERSO"
              onChange={(e) => set({ apiKeyEnv: e.target.value.toUpperCase() || null })}
            />
          </Field>
        )}

        {probe?.envCandidates.length ? (
          <p className="hint">
            Définies sur le serveur : <span className="mono">{probe.envCandidates.join(', ')}</span>
          </p>
        ) : null}

        {draft.kind === 'http-api' && (
          <div className="row gap-3">
            <Field label="Dialecte">
              <select
                className="input"
                value={draft.apiFlavor ?? 'anthropic'}
                onChange={(e) => {
                  const apiFlavor = e.target.value as 'anthropic' | 'openai';
                  set({ apiFlavor, baseUrl: API_BASE_URLS[apiFlavor] });
                }}
              >
                <option value="anthropic">Anthropic Messages</option>
                <option value="openai">Compatible OpenAI</option>
              </select>
            </Field>
            <Field label="Racine de l’API">
              <input
                className="input"
                value={draft.baseUrl ?? ''}
                onChange={(e) => set({ baseUrl: e.target.value || null })}
              />
            </Field>
          </div>
        )}

        {(draft.kind === 'codex-cli' || draft.kind === 'opencode-cli') && (
          <>
            <Field
              label="Commande"
              hint="Les options non interactives changent d’une version à l’autre : vérifie-les avec le bouton « Tester »."
            >
              <input
                className="input mono"
                value={draft.command ?? ''}
                onChange={(e) => set({ command: e.target.value || null })}
              />
            </Field>
            <Field
              label="Arguments (un par ligne)"
              hint="Laisse vide : Maestro déduit l’invocation de l’aide du binaire installé, et n’ajoute que les options qu’il déclare. Ne remplis ce champ que pour imposer ta propre ligne de commande. Variables : {{prompt}}, {{model}}, {{cwd}}."
            >
              <textarea
                className="input mono"
                rows={5}
                placeholder={
                  probe?.invocation
                    ? `détecté : ${probe.invocation.join(' ')}`
                    : 'détection automatique'
                }
                value={(draft.args ?? []).join('\n')}
                onChange={(e) => {
                  const lines = e.target.value.split('\n').filter((line) => line !== '');
                  /* Champ vidé = retour à la détection automatique, pas un
                     tableau vide qui lancerait la commande sans prompt. */
                  set({ args: lines.length > 0 ? lines : null });
                }}
              />
            </Field>
          </>
        )}

        <div className="row gap-3">
          <Field label="Modèle imposé" hint="Vide = celui de l’agent.">
            <input
              className="input"
              value={draft.model ?? ''}
              onChange={(e) => set({ model: e.target.value || null })}
            />
          </Field>
          <Field label="Priorité" hint="Le plus petit passe en premier.">
            <input
              className="input"
              type="number"
              value={draft.priority}
              onChange={(e) => set({ priority: Number(e.target.value) })}
            />
          </Field>
          <Field label="Plafond quotidien ($)" hint="Vide = pas de plafond.">
            <input
              className="input"
              type="number"
              step="0.01"
              value={draft.dailyCostLimitUsd ?? ''}
              onChange={(e) =>
                set({ dailyCostLimitUsd: e.target.value === '' ? null : Number(e.target.value) })
              }
            />
          </Field>
        </div>

        <div className="row gap-3">
          <Field
            label="Fenêtre de mesure (h)"
            hint="Sur quelle durée glissante la consommation est comptée. 5 h correspond à la session des abonnements Claude."
          >
            <input
              className="input"
              type="number"
              min={1}
              max={168}
              value={Math.round(draft.usageWindowSec / 3600)}
              onChange={(e) => set({ usageWindowSec: Math.max(1, Number(e.target.value)) * 3600 })}
            />
          </Field>
          <Field
            label="Plafond de la fenêtre (tokens)"
            hint="Vide : Maestro l’apprend en observant la consommation atteinte au moment où ce compte heurte sa limite. Renseigne-le si tu connais ton contrat — une valeur déclarée l’emporte sur une estimation."
          >
            <input
              className="input"
              type="number"
              min={0}
              placeholder={
                probe && draft.kind === 'claude-sdk' ? 'appris à la première limite' : 'aucun'
              }
              value={draft.windowTokenLimit ?? ''}
              onChange={(e) =>
                set({ windowTokenLimit: e.target.value === '' ? null : Number(e.target.value) })
              }
            />
          </Field>
        </div>

        <label className="row gap-2 items-center">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          Compte actif
        </label>

        <div className="row gap-2">
          <span className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Annuler
          </button>
          <button className="btn primary" onClick={props.onSave} disabled={!draft.name.trim()}>
            Enregistrer
          </button>
        </div>
      </div>
    </Modal>
  );
}

function PolicyModal(props: {
  form: { id: string | null; draft: ResiliencePolicyCreate };
  accounts: ProviderAccount[];
  onChange: (draft: ResiliencePolicyCreate) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { draft } = props.form;
  const set = (patch: Partial<ResiliencePolicyCreate>) => props.onChange({ ...draft, ...patch });

  const move = (index: number, delta: number) => {
    const next = draft.targets.slice();
    const target = next[index];
    const swap = next[index + delta];
    if (!target || !swap) return;
    next[index] = swap;
    next[index + delta] = target;
    set({ targets: next });
  };

  const available = props.accounts.filter((a) => !draft.targets.some((t) => t.accountId === a.id));

  return (
    <Modal
      title={props.form.id ? 'Modifier la politique' : 'Nouvelle politique'}
      onClose={props.onClose}
      wide
    >
      <div className="col gap-3">
        <Field label="Nom">
          <input
            className="input"
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
        <Field label="Description">
          <input
            className="input"
            value={draft.description}
            onChange={(e) => set({ description: e.target.value })}
          />
        </Field>

        <Field
          label="Ordre des comptes"
          hint="Le premier disponible exécute. En cas de quota, on bascule sur le suivant plutôt que d’attendre."
        >
          <div className="col gap-2">
            {draft.targets.length === 0 && (
              <span className="hint warn">
                <Warning /> Sans cible, cette politique n’offre aucun repli.
              </span>
            )}
            {draft.targets.map((target, index) => {
              const account = props.accounts.find((a) => a.id === target.accountId);
              return (
                <div className="row gap-2 items-center" key={target.accountId}>
                  <span className="badge">{index + 1}</span>
                  <strong>{account?.name ?? '⚠ compte supprimé'}</strong>
                  {account && <span className="muted sm">{PROVIDER_LABELS[account.kind]}</span>}
                  <input
                    className="input sm"
                    placeholder="modèle (facultatif)"
                    value={target.model ?? ''}
                    onChange={(e) => {
                      const next = draft.targets.slice();
                      next[index] = { ...target, model: e.target.value || null };
                      set({ targets: next });
                    }}
                  />
                  <span className="spacer" />
                  <button className="btn sm" onClick={() => move(index, -1)} disabled={index === 0}>
                    ↑
                  </button>
                  <button
                    className="btn sm"
                    onClick={() => move(index, 1)}
                    disabled={index === draft.targets.length - 1}
                  >
                    ↓
                  </button>
                  <button
                    className="btn sm danger"
                    onClick={() =>
                      set({
                        targets: draft.targets.filter((t) => t.accountId !== target.accountId),
                      })
                    }
                  >
                    Retirer
                  </button>
                </div>
              );
            })}
            {available.length > 0 && (
              <select
                className="input"
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  set({ targets: [...draft.targets, { accountId: e.target.value, model: null }] });
                }}
              >
                <option value="">Ajouter un compte…</option>
                {available.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {PROVIDER_LABELS[a.kind]}
                  </option>
                ))}
              </select>
            )}
          </div>
        </Field>

        <div className="row gap-3">
          <Field label="Essais par compte">
            <input
              className="input"
              type="number"
              min={1}
              value={draft.maxAttemptsPerTarget}
              onChange={(e) => set({ maxAttemptsPerTarget: Number(e.target.value) })}
            />
          </Field>
          <Field label="Essais au total">
            <input
              className="input"
              type="number"
              min={1}
              value={draft.maxTotalAttempts}
              onChange={(e) => set({ maxTotalAttempts: Number(e.target.value) })}
            />
          </Field>
          <Field
            label="Attente max de quota (s)"
            hint="Au-delà, on bascule plutôt que d’immobiliser le run."
          >
            <input
              className="input"
              type="number"
              min={0}
              value={draft.quotaWaitMaxSec}
              onChange={(e) => set({ quotaWaitMaxSec: Number(e.target.value) })}
            />
          </Field>
        </div>

        <div className="row gap-3">
          <Field label="Attente initiale (ms)">
            <input
              className="input"
              type="number"
              min={0}
              value={draft.backoffInitialMs}
              onChange={(e) => set({ backoffInitialMs: Number(e.target.value) })}
            />
          </Field>
          <Field label="Facteur">
            <input
              className="input"
              type="number"
              step="0.5"
              min={1}
              value={draft.backoffFactor}
              onChange={(e) => set({ backoffFactor: Number(e.target.value) })}
            />
          </Field>
          <Field label="Attente max (ms)">
            <input
              className="input"
              type="number"
              min={0}
              value={draft.backoffMaxMs}
              onChange={(e) => set({ backoffMaxMs: Number(e.target.value) })}
            />
          </Field>
          <Field
            label="Seuil de résumé (%)"
            hint="Du budget de tokens de l’agent, ou de la fenêtre du compte. 0 désactive la capture anticipée ; le filet de sécurité reste actif."
          >
            <input
              className="input"
              type="number"
              min={0}
              max={100}
              value={draft.handoffThresholdPct}
              onChange={(e) => set({ handoffThresholdPct: Number(e.target.value) })}
            />
          </Field>
          <Field
            label="Anticipation de quota (%)"
            hint="Au-delà de ce niveau de remplissage, un compte est laissé de côté s’il en existe un plus calme. Il n’est jamais refusé : quand tous sont chargés, l’ordre déclaré reprend la main. 0 désactive."
          >
            <input
              className="input"
              type="number"
              min={0}
              max={100}
              value={draft.quotaPressurePct}
              onChange={(e) => set({ quotaPressurePct: Number(e.target.value) })}
            />
          </Field>
        </div>

        <div className="row gap-4">
          <label className="row gap-2 items-center">
            <input
              type="checkbox"
              checked={draft.switchOnError}
              onChange={(e) => set({ switchOnError: e.target.checked })}
            />
            Basculer aussi sur erreur réseau ou saturation
          </label>
          <label className="row gap-2 items-center">
            <input
              type="checkbox"
              checked={draft.backoffJitter}
              onChange={(e) => set({ backoffJitter: e.target.checked })}
            />
            Étaler les reprises (jitter)
          </label>
        </div>

        <div className="row gap-2">
          <span className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Annuler
          </button>
          <button className="btn primary" onClick={props.onSave} disabled={!draft.name.trim()}>
            Enregistrer
          </button>
        </div>
      </div>
    </Modal>
  );
}
