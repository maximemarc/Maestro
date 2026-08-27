/**
 * Page MCP : registre des serveurs, et constructeur d'outils maison.
 *
 * Deux natures dans une seule liste, parce que du point de vue de l'agent c'est
 * la même chose — un serveur qui expose des outils. La distinction n'apparaît
 * qu'à la création, où elle change ce qu'il y a à remplir.
 */
import { useMemo, useState } from 'react';
import {
  ArrowSquareOut,
  CheckCircle,
  DownloadSimple,
  MagnifyingGlass,
  Plug,
  Play,
  Plus,
  PlugsConnected,
  Warning,
  Wrench,
} from '@phosphor-icons/react';
import type {
  McpAction,
  McpImportCandidate,
  McpProbeResult,
  McpServerDef,
  McpToolDef,
  McpToolParam,
  McpToolTrial,
} from '@maestro/shared';
import { api, type McpImportSource, type McpServerInput } from '../lib/api';
import { useStore } from '../lib/store';
import { ConfirmButton, EmptyState, ErrorText, Field, Modal, Spinner } from '../components/ui';

/** Marqueur employé par le serveur pour une valeur sensible déjà enregistrée. */
const SECRET_MASK = '••••••••';

const BLANK_PARAM: McpToolParam = {
  name: '',
  type: 'string',
  description: '',
  required: true,
  enumValues: [],
};

const BLANK_HTTP: McpAction = {
  kind: 'http',
  method: 'GET',
  urlTemplate: '',
  headers: {},
  bodyTemplate: '',
  responsePath: '',
  timeoutMs: 15000,
};

const BLANK_TOOL: McpToolDef = {
  name: '',
  description: '',
  params: [],
  action: BLANK_HTTP,
  requiresApproval: false,
};

function blankForm(kind: McpServerDef['kind']): McpServerInput {
  return {
    slug: '',
    name: '',
    description: '',
    kind,
    enabled: true,
    transport: kind === 'external' ? 'stdio' : null,
    command: null,
    args: [],
    env: {},
    url: null,
    headers: {},
    tools: kind === 'custom' ? [{ ...BLANK_TOOL }] : [],
  };
}

function toForm(def: McpServerDef): McpServerInput {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = def;
  return rest;
}

/** Rend une carte clé/valeur éditable comme un texte « clé: valeur » par ligne. */
function mapToLines(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

function linesToMap(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const at = trimmed.indexOf(':');
    if (at === -1) continue;
    const key = trimmed.slice(0, at).trim();
    if (key !== '') out[key] = trimmed.slice(at + 1).trim();
  }
  return out;
}

/**
 * Champ dont la valeur structurée est dérivée de la frappe, sans réécrire ce
 * qui est tapé.
 *
 * Un champ contrôlé qui réaffiche le résultat de sa propre analyse détruit la
 * saisie en cours. Deux cas observés ici : taper « janvier, » produit un
 * tableau d'un élément, réaffiché « janvier » — la virgule disparaît sous les
 * doigts ; et taper « authorization » avant les deux-points ne produit aucune
 * entrée, donc le champ s'efface entièrement. On garde donc le texte brut comme
 * source d'affichage, et on ne remonte que la valeur analysée.
 *
 * La valeur initiale n'est lue qu'au montage : le parent est remonté avec une
 * clé stable, et resynchroniser à chaque rendu ramènerait le défaut.
 */
function RawInput(props: {
  initial: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  onRaw: (raw: string) => void;
}) {
  const [raw, setRaw] = useState(props.initial);
  return (
    <input
      className={props.className}
      value={raw}
      placeholder={props.placeholder}
      disabled={props.disabled}
      aria-label={props.ariaLabel}
      onChange={(e) => {
        setRaw(e.target.value);
        props.onRaw(e.target.value);
      }}
    />
  );
}

function RawTextarea(props: {
  initial: string;
  rows: number;
  placeholder?: string;
  onRaw: (raw: string) => void;
}) {
  const [raw, setRaw] = useState(props.initial);
  return (
    <textarea
      className="textarea"
      rows={props.rows}
      value={raw}
      placeholder={props.placeholder}
      onChange={(e) => {
        setRaw(e.target.value);
        props.onRaw(e.target.value);
      }}
    />
  );
}

export default function McpPage() {
  const servers = useStore((s) => s.mcpServers);
  const notify = useStore((s) => s.notify);

  const [pageError, setPageError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; form: McpServerInput } | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const custom = useMemo(() => servers.filter((s) => s.kind === 'custom'), [servers]);
  const external = useMemo(() => servers.filter((s) => s.kind === 'external'), [servers]);

  const openCreate = (kind: McpServerDef['kind']) => {
    setFormError(null);
    setEditing({ id: null, form: blankForm(kind) });
  };

  const openEdit = (def: McpServerDef) => {
    setFormError(null);
    setEditing({ id: def.id, form: toForm(def) });
  };

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setFormError(null);
    try {
      if (editing.id) {
        await api.updateMcpServer(editing.id, editing.form);
        notify(`« ${editing.form.name} » enregistré.`);
      } else {
        await api.createMcpServer(editing.form);
        notify(`« ${editing.form.name} » créé.`);
      }
      setEditing(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (def: McpServerDef) => {
    setPageError(null);
    try {
      await api.deleteMcpServer(def.id);
      notify(`« ${def.name} » supprimé.`);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : 'Erreur inconnue');
    }
  };

  const toggle = async (def: McpServerDef) => {
    setPageError(null);
    try {
      await api.updateMcpServer(def.id, { ...toForm(def), enabled: !def.enabled });
    } catch (err) {
      setPageError(err instanceof Error ? err.message : 'Erreur inconnue');
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>MCP</h1>
        <span className="spacer" />
        <button className="btn" onClick={() => setImportOpen(true)}>
          <DownloadSimple />
          Importer une configuration
        </button>
        <button className="btn" onClick={() => openCreate('external')}>
          <Plug />
          Déclarer un serveur
        </button>
        <button className="btn primary" onClick={() => openCreate('custom')}>
          <Plus />
          Créer des outils
        </button>
      </div>
      <p className="page-lede">
        Un serveur MCP donne des outils à tes agents. Soit tu déclares un serveur qui existe déjà,
        soit tu décris tes outils ici et Maestro les expose lui-même : appel HTTP ou réponse
        gabaritée, sans dépôt à écrire ni processus à faire tourner. Un serveur devient visible pour
        un agent quand tu l'actives dans sa configuration.
      </p>

      {pageError && <ErrorText>{pageError}</ErrorText>}

      {servers.length === 0 ? (
        <EmptyState
          icon={<Plug size={28} />}
          title="Aucun serveur MCP"
          hint="Commence par créer des outils : c'est le chemin le plus court pour donner une capacité concrète à un agent."
        >
          <button className="btn primary" onClick={() => openCreate('custom')}>
            <Plus />
            Créer des outils
          </button>
        </EmptyState>
      ) : (
        <div className="col gap-4">
          {custom.length > 0 && (
            <section>
              <h2>Outils maison</h2>
              <div className="col gap-3 mt-3">
                {custom.map((def) => (
                  <ServerCard
                    key={def.id}
                    def={def}
                    onEdit={() => openEdit(def)}
                    onToggle={() => void toggle(def)}
                    onRemove={() => void remove(def)}
                  />
                ))}
              </div>
            </section>
          )}

          {external.length > 0 && (
            <section>
              <h2>Serveurs déclarés</h2>
              <div className="col gap-3 mt-3">
                {external.map((def) => (
                  <ServerCard
                    key={def.id}
                    def={def}
                    onEdit={() => openEdit(def)}
                    onToggle={() => void toggle(def)}
                    onRemove={() => void remove(def)}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {importOpen && <ImportModal onClose={() => setImportOpen(false)} />}

      {editing && (
        <ServerModal
          state={editing}
          busy={busy}
          error={formError}
          onChange={(form) => setEditing({ ...editing, form })}
          onClose={() => setEditing(null)}
          onSave={() => void save()}
        />
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Carte d'un serveur
 * ------------------------------------------------------------------------ */

function ServerCard(props: {
  def: McpServerDef;
  onEdit: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const { def } = props;
  const [trialTool, setTrialTool] = useState<McpToolDef | null>(null);
  const [probe, setProbe] = useState<McpProbeResult | null>(null);
  const [probing, setProbing] = useState(false);

  /* Sonde le serveur : répond-il, et qu'expose-t-il réellement. */
  const runProbe = async () => {
    setProbing(true);
    setProbe(null);
    try {
      setProbe(await api.probeMcpServer(def.id));
    } catch (err) {
      setProbe({
        ok: false,
        serverInfo: null,
        tools: [],
        message: err instanceof Error ? err.message : 'Erreur inconnue',
        durationMs: 0,
      });
    } finally {
      setProbing(false);
    }
  };

  /* L'export est téléchargé côté navigateur : la définition est déjà masquée
     par le serveur, il n'y a rien à protéger de plus. */
  const exportDef = async () => {
    const portable = await api.exportMcpServer(def.id);
    const blob = new Blob([JSON.stringify(portable, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `mcp-${def.slug}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={`card${def.enabled ? '' : ' card-off'}`}>
      <div className="row wrap">
        <strong className="text-md">{def.name}</strong>
        <span className="badge mono">{def.slug}</span>
        {def.kind === 'custom' ? (
          <span className="badge accent">{def.tools.length} outil(s)</span>
        ) : (
          <span className="badge violet">{def.transport}</span>
        )}
        {!def.enabled && <span className="badge warn">désactivé</span>}
        <span className="spacer grow" />
        {def.kind === 'external' && (
          <button className="btn ghost sm" onClick={() => void runProbe()} disabled={probing}>
            {probing ? <Spinner /> : <PlugsConnected />}
            Tester
          </button>
        )}
        <button className="btn ghost sm" onClick={() => void exportDef()}>
          <ArrowSquareOut />
          Exporter
        </button>
        <button className="btn ghost sm" onClick={props.onToggle}>
          {def.enabled ? 'Désactiver' : 'Activer'}
        </button>
        <button className="btn sm" onClick={props.onEdit}>
          Modifier
        </button>
        <ConfirmButton
          label="Supprimer"
          title="Supprimer ce serveur MCP ?"
          message={`« ${def.name} » sera retiré des agents qui le chargent. Les runs passés restent consultables.`}
          confirmLabel="Supprimer"
          className="btn danger sm"
          onConfirm={props.onRemove}
        />
      </div>

      {def.description && <p className="text-muted text-sm mt-2 prose">{def.description}</p>}

      {def.kind === 'external' && (
        <code className="break-all text-xs mt-2">
          {def.transport === 'stdio' ? [def.command, ...def.args].join(' ') : def.url}
        </code>
      )}

      {probe && (
        <div className={`tile mt-3${probe.ok ? '' : ' tile-danger'}`} role="status">
          <div className="row gap-2 wrap">
            <span className={probe.ok ? 'text-ok' : 'text-danger'}>
              {probe.ok ? <CheckCircle size={16} /> : <Warning size={16} />}
            </span>
            <strong className="text-sm">{probe.message}</strong>
            {probe.serverInfo && <span className="badge mono">{probe.serverInfo}</span>}
            <span className="text-faint text-xs num ml-auto">{probe.durationMs} ms</span>
          </div>
          {probe.tools.length > 0 && (
            <div className="row gap-2 wrap mt-2">
              <span className="text-faint text-xs">Outils exposés :</span>
              {probe.tools.map((tool) => (
                <code key={tool} className="text-xs">
                  {tool}
                </code>
              ))}
            </div>
          )}
        </div>
      )}

      {def.kind === 'custom' && def.tools.length > 0 && (
        <div className="mt-3">
          <div className="section-label">Outils exposés</div>
          <div className="col gap-2">
            {def.tools.map((tool) => (
              <div key={tool.name} className="tile row wrap gap-2">
                <code>{tool.name}</code>
                <span className="badge">{tool.action.kind === 'http' ? 'HTTP' : 'texte'}</span>
                {tool.requiresApproval && <span className="badge warn">approbation</span>}
                <span className="text-muted text-sm grow ellipsis">{tool.description}</span>
                <button className="btn ghost sm" onClick={() => setTrialTool(tool)}>
                  <Play />
                  Essayer
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {trialTool && (
        <TrialModal serverId={def.id} tool={trialTool} onClose={() => setTrialTool(null)} />
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Essai d'un outil
 * ------------------------------------------------------------------------ */

/**
 * Essai d'un outil avant de l'ouvrir aux agents.
 *
 * Sans cet écran, la première exécution réelle a lieu au milieu du run d'un
 * agent : l'erreur est alors noyée dans un transcript, et il faut relancer un
 * run complet pour la reproduire.
 */
function TrialModal(props: { serverId: string; tool: McpToolDef; onClose: () => void }) {
  const [args, setArgs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<McpToolTrial | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      /* Les valeurs saisies sont du texte : on les convertit selon le type
         déclaré, sinon un paramètre numérique arriverait en chaîne et le
         schéma du serveur le refuserait. */
      const typed: Record<string, unknown> = {};
      for (const param of props.tool.params) {
        const raw = args[param.name];
        if (raw === undefined || raw === '') continue;
        typed[param.name] =
          param.type === 'number' ? Number(raw) : param.type === 'boolean' ? raw === 'true' : raw;
      }
      setResult(await api.trialMcpTool(props.serverId, props.tool.name, typed));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Essayer ${props.tool.name}`} onClose={props.onClose}>
      <p className="text-muted text-sm prose">{props.tool.description}</p>

      {props.tool.params.length === 0 ? (
        <p className="text-faint text-sm">Cet outil ne prend aucun paramètre.</p>
      ) : (
        props.tool.params.map((param) => (
          <Field
            key={param.name}
            label={`${param.name}${param.required ? '' : ' (optionnel)'}`}
            hint={param.description || undefined}
          >
            {param.enumValues.length > 0 ? (
              <select
                className="select"
                value={args[param.name] ?? ''}
                onChange={(e) => setArgs({ ...args, [param.name]: e.target.value })}
              >
                <option value="">Choisir</option>
                {param.enumValues.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            ) : param.type === 'boolean' ? (
              <select
                className="select"
                value={args[param.name] ?? ''}
                onChange={(e) => setArgs({ ...args, [param.name]: e.target.value })}
              >
                <option value="">Choisir</option>
                <option value="true">vrai</option>
                <option value="false">faux</option>
              </select>
            ) : (
              <input
                className="input"
                type={param.type === 'number' ? 'number' : 'text'}
                value={args[param.name] ?? ''}
                onChange={(e) => setArgs({ ...args, [param.name]: e.target.value })}
              />
            )}
          </Field>
        ))
      )}

      {error && <ErrorText>{error}</ErrorText>}

      {result && (
        <div className="mt-3">
          <div className="row gap-2">
            <span className={`badge ${result.ok ? 'ok' : 'danger'}`}>
              {result.ok ? 'succès' : 'échec'}
            </span>
            <span className="text-faint text-xs num">{result.durationMs} ms</span>
          </div>
          <pre className="scroll-box break-word mt-2">{result.output}</pre>
        </div>
      )}

      <div className="modal-actions">
        <button className="btn ghost" onClick={props.onClose}>
          Fermer
        </button>
        <button className="btn primary" onClick={() => void run()} disabled={busy}>
          {busy ? <Spinner /> : <Play />}
          Exécuter
        </button>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------------------
 * Import d'une configuration existante
 * ------------------------------------------------------------------------ */

/**
 * Import en deux temps : on regarde, puis on choisit.
 *
 * La prévisualisation n'écrit rien et ne montre aucun secret, seulement leur
 * nombre. L'import relit la source côté serveur : les jetons du fichier ne
 * passent donc jamais par le navigateur.
 */
function ImportModal({ onClose }: { onClose: () => void }) {
  const notify = useStore((s) => s.notify);
  const [mode, setMode] = useState<'path' | 'json'>('path');
  const [path, setPath] = useState('');
  const [json, setJson] = useState('');
  const [candidates, setCandidates] = useState<McpImportCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const source = (): McpImportSource => (mode === 'path' ? { path } : { json });

  const preview = async () => {
    setBusy(true);
    setError(null);
    setCandidates(null);
    try {
      const found = await api.previewMcpImport(source());
      setCandidates(found);
      /* Présélection de ce qui est importable et pas déjà là : c'est ce que
         l'utilisateur veut dans la quasi-totalité des cas. */
      setSelected(
        new Set(found.filter((c) => c.importable && !c.alreadyPresent).map((c) => c.name)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.runMcpImport(source(), [...selected]);
      notify(`${result.created.length} serveur(s) importé(s).`);
      if (result.failed.length > 0) {
        setError(result.failed.map((f) => `${f.name} : ${f.reason}`).join(' · '));
      } else {
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (name: string) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelected(next);
  };

  return (
    <Modal title="Importer une configuration MCP" onClose={onClose} wide>
      <p className="text-muted text-sm prose">
        Les serveurs MCP se déclarent partout dans le même format. Pointe un fichier (
        <code>.mcp.json</code>, configuration de Claude Code ou de Claude Desktop) ou colle son
        contenu : Maestro te dira ce qu'il y trouve avant d'écrire quoi que ce soit.
      </p>

      <Field label="Source">
        <select
          className="select"
          value={mode}
          onChange={(e) => {
            setMode(e.target.value as 'path' | 'json');
            setCandidates(null);
          }}
        >
          <option value="path">Fichier sur la machine</option>
          <option value="json">Contenu collé</option>
        </select>
      </Field>

      {mode === 'path' ? (
        <Field label="Chemin" hint="Le fichier est lu par le serveur, pas par le navigateur.">
          <input
            className="input mono"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/home/utilisateur/.claude.json"
            data-autofocus
          />
        </Field>
      ) : (
        <Field label="Configuration JSON">
          <textarea
            className="textarea"
            rows={8}
            value={json}
            onChange={(e) => setJson(e.target.value)}
            placeholder={'{ "mcpServers": { … } }'}
            data-autofocus
          />
        </Field>
      )}

      <button
        className="btn"
        onClick={() => void preview()}
        disabled={busy || (mode === 'path' ? path.trim() === '' : json.trim() === '')}
      >
        {busy ? <Spinner /> : <MagnifyingGlass />}
        Analyser
      </button>

      {error && <ErrorText>{error}</ErrorText>}

      {candidates !== null && (
        <div className="mt-4">
          <div className="section-label">{candidates.length} entrée(s) trouvée(s)</div>
          {candidates.length === 0 ? (
            <p className="text-faint text-sm">
              Aucun serveur MCP dans ce fichier. Vérifie qu'il contient bien une clé
              <code> mcpServers</code>.
            </p>
          ) : (
            <div className="col gap-2">
              {candidates.map((candidate) => (
                <label
                  key={candidate.name}
                  className={`tile row gap-2 wrap${candidate.importable ? '' : ' tile-off'}`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(candidate.name)}
                    disabled={!candidate.importable}
                    onChange={() => toggle(candidate.name)}
                  />
                  <strong className="text-sm">{candidate.name}</strong>
                  {candidate.transport && (
                    <span className="badge violet">{candidate.transport}</span>
                  )}
                  {candidate.secretCount > 0 && (
                    <span className="badge warn">{candidate.secretCount} secret(s) reprise(s)</span>
                  )}
                  {candidate.alreadyPresent && <span className="badge">déjà présent</span>}
                  <code className="text-xs break-all grow">{candidate.summary}</code>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose} disabled={busy}>
          Annuler
        </button>
        <button
          className="btn primary"
          onClick={() => void runImport()}
          disabled={busy || selected.size === 0}
        >
          {busy && <Spinner />}
          Importer {selected.size > 0 ? `(${selected.size})` : ''}
        </button>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------------------
 * Formulaire de serveur
 * ------------------------------------------------------------------------ */

function ServerModal(props: {
  state: { id: string | null; form: McpServerInput };
  busy: boolean;
  error: string | null;
  onChange: (form: McpServerInput) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { form } = props.state;
  const set = <K extends keyof McpServerInput>(key: K, value: McpServerInput[K]) =>
    props.onChange({ ...form, [key]: value });

  const title =
    form.kind === 'custom'
      ? props.state.id
        ? 'Modifier les outils'
        : 'Créer des outils'
      : props.state.id
        ? 'Modifier le serveur'
        : 'Déclarer un serveur MCP';

  return (
    <Modal title={title} onClose={props.onClose} wide>
      <div className="grid cols-2">
        <Field label="Nom">
          <input
            className="input"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Ex. Boîte à outils interne"
            data-autofocus
          />
        </Field>
        <Field
          label="Identifiant"
          hint="Vu par le modèle dans le nom des outils. Généré depuis le nom si vide."
        >
          <input
            className="input mono"
            value={form.slug}
            onChange={(e) => set('slug', e.target.value)}
            placeholder="boite-a-outils"
          />
        </Field>
      </div>

      <Field label="Description" hint="À quoi sert ce serveur, pour toi et pour la relecture.">
        <input
          className="input"
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
        />
      </Field>

      {form.kind === 'external' ? (
        <ExternalFields form={form} set={set} />
      ) : (
        <ToolsEditor form={form} set={set} />
      )}

      <label className="checkbox-row mb-3">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => set('enabled', e.target.checked)}
        />
        Actif : les agents qui le chargent le voient
      </label>

      {props.error && <ErrorText>{props.error}</ErrorText>}

      <div className="modal-actions">
        <button className="btn ghost" onClick={props.onClose} disabled={props.busy}>
          Annuler
        </button>
        <button
          className="btn primary"
          onClick={props.onSave}
          disabled={props.busy || form.name.trim() === ''}
        >
          {props.busy && <Spinner />}
          Enregistrer
        </button>
      </div>
    </Modal>
  );
}

function ExternalFields(props: {
  form: McpServerInput;
  set: <K extends keyof McpServerInput>(key: K, value: McpServerInput[K]) => void;
}) {
  const { form, set } = props;
  return (
    <>
      <Field label="Transport">
        <select
          className="select"
          value={form.transport ?? 'stdio'}
          onChange={(e) => set('transport', e.target.value as McpServerInput['transport'])}
        >
          <option value="stdio">stdio : un processus local</option>
          <option value="http">http : un service distant</option>
          <option value="sse">sse : un service distant en flux</option>
        </select>
      </Field>

      {form.transport === 'stdio' ? (
        <>
          <Field label="Commande">
            <input
              className="input mono"
              value={form.command ?? ''}
              onChange={(e) => set('command', e.target.value)}
              placeholder="npx"
            />
          </Field>
          <Field label="Arguments" hint="Un par ligne.">
            <textarea
              className="textarea"
              rows={3}
              value={form.args.join('\n')}
              onChange={(e) => set('args', e.target.value.split('\n'))}
              placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/chemin'}
            />
          </Field>
          <Field
            label="Variables d'environnement"
            hint="Une par ligne, au format CLE: valeur. Les valeurs enregistrées sont masquées : laisse le masque pour les conserver."
          >
            <RawTextarea
              initial={mapToLines(form.env)}
              rows={3}
              onRaw={(raw) => set('env', linesToMap(raw))}
              placeholder="API_TOKEN: ..."
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="URL">
            <input
              className="input mono"
              value={form.url ?? ''}
              onChange={(e) => set('url', e.target.value)}
              placeholder="https://exemple.interne/mcp"
            />
          </Field>
          <Field
            label="En-têtes"
            hint="Un par ligne, au format Cle: valeur. Les valeurs enregistrées sont masquées."
          >
            <RawTextarea
              initial={mapToLines(form.headers)}
              rows={3}
              onRaw={(raw) => set('headers', linesToMap(raw))}
              placeholder="authorization: Bearer ..."
            />
          </Field>
        </>
      )}
    </>
  );
}

/* --------------------------------------------------------------------------
 * Constructeur d'outils
 * ------------------------------------------------------------------------ */

function ToolsEditor(props: {
  form: McpServerInput;
  set: <K extends keyof McpServerInput>(key: K, value: McpServerInput[K]) => void;
}) {
  const { form, set } = props;

  const updateTool = (index: number, tool: McpToolDef) => {
    const next = form.tools.slice();
    next[index] = tool;
    set('tools', next);
  };

  return (
    <div className="col gap-3">
      <div className="section-label">Outils</div>
      {form.tools.map((tool, index) => (
        <ToolEditor
          key={index}
          tool={tool}
          onChange={(next) => updateTool(index, next)}
          onRemove={
            form.tools.length > 1
              ? () =>
                  set(
                    'tools',
                    form.tools.filter((_, i) => i !== index),
                  )
              : null
          }
        />
      ))}
      <div>
        <button className="btn sm" onClick={() => set('tools', [...form.tools, { ...BLANK_TOOL }])}>
          <Plus />
          Ajouter un outil
        </button>
      </div>
    </div>
  );
}

function ToolEditor(props: {
  tool: McpToolDef;
  onChange: (tool: McpToolDef) => void;
  onRemove: (() => void) | null;
}) {
  const { tool } = props;
  const set = <K extends keyof McpToolDef>(key: K, value: McpToolDef[K]) =>
    props.onChange({ ...tool, [key]: value });

  const setAction = (action: McpAction) => props.onChange({ ...tool, action });

  return (
    <div className="card tile-card">
      <div className="row wrap">
        <Wrench />
        <strong>{tool.name || 'Nouvel outil'}</strong>
        <span className="spacer grow" />
        {props.onRemove && (
          <button className="btn ghost sm" onClick={props.onRemove}>
            Retirer
          </button>
        )}
      </div>

      <div className="grid cols-2 mt-3">
        <Field label="Nom de l'outil" hint="Minuscules et tirets bas. Vu par le modèle.">
          <input
            className="input mono"
            value={tool.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="procedure_cloture"
          />
        </Field>
        <Field label="Action">
          <select
            className="select"
            value={tool.action.kind}
            onChange={(e) =>
              setAction(
                e.target.value === 'text' ? { kind: 'text', template: '' } : { ...BLANK_HTTP },
              )
            }
          >
            <option value="http">Appel HTTP</option>
            <option value="text">Réponse gabaritée</option>
          </select>
        </Field>
      </div>

      <Field
        label="Description"
        hint="C'est elle qui décide si le modèle appelle l'outil, et quand. Sois explicite."
      >
        <input
          className="input"
          value={tool.description}
          onChange={(e) => set('description', e.target.value)}
          placeholder="Renvoie la procédure de clôture pour un mois donné."
        />
      </Field>

      <label className="checkbox-row mb-3">
        <input
          type="checkbox"
          checked={tool.requiresApproval}
          onChange={(e) => set('requiresApproval', e.target.checked)}
        />
        Demander une approbation à chaque appel
      </label>
      <p className="text-faint text-xs mb-3">
        À cocher pour un outil qui modifie quelque chose. Sans cela, l'outil suit la politique
        d'approbation de l'agent, qui ne distingue pas une consultation d'une écriture.
      </p>

      <ParamsEditor params={tool.params} onChange={(params) => set('params', params)} />

      {tool.action.kind === 'http' ? (
        <HttpActionFields action={tool.action} onChange={setAction} />
      ) : (
        <Field
          label="Texte renvoyé"
          hint="Les {{paramètres}} sont remplacés par les valeurs de l'appel."
        >
          <textarea
            className="textarea"
            value={tool.action.template}
            onChange={(e) => setAction({ kind: 'text', template: e.target.value })}
            placeholder={'Procédure pour {{mois}} :\n1. …'}
          />
        </Field>
      )}
    </div>
  );
}

function ParamsEditor(props: {
  params: McpToolParam[];
  onChange: (params: McpToolParam[]) => void;
}) {
  const update = (index: number, param: McpToolParam) => {
    const next = props.params.slice();
    next[index] = param;
    props.onChange(next);
  };

  return (
    <div className="mt-2">
      <div className="section-label">Paramètres</div>
      {props.params.length === 0 && (
        <p className="text-faint text-sm">Aucun paramètre : l'outil s'appelle sans argument.</p>
      )}
      <div className="col gap-2">
        {props.params.map((param, index) => (
          <div key={index} className="row wrap gap-2">
            <input
              className="input mono w-md"
              value={param.name}
              onChange={(e) => update(index, { ...param, name: e.target.value })}
              placeholder="nom"
              aria-label={`Nom du paramètre ${index + 1}`}
            />
            <select
              className="select w-sm"
              value={param.type}
              onChange={(e) =>
                update(index, { ...param, type: e.target.value as McpToolParam['type'] })
              }
              aria-label={`Type du paramètre ${index + 1}`}
            >
              <option value="string">texte</option>
              <option value="number">nombre</option>
              <option value="boolean">booléen</option>
            </select>
            <input
              className="input grow"
              value={param.description}
              onChange={(e) => update(index, { ...param, description: e.target.value })}
              placeholder="à quoi il sert"
              aria-label={`Description du paramètre ${index + 1}`}
            />
            <RawInput
              className="input w-md"
              initial={param.enumValues.join(', ')}
              onRaw={(raw) =>
                update(index, {
                  ...param,
                  enumValues: raw
                    .split(',')
                    .map((v) => v.trim())
                    .filter((v) => v !== ''),
                })
              }
              placeholder="valeurs, séparées"
              ariaLabel={`Valeurs autorisées du paramètre ${index + 1}`}
              disabled={param.type !== 'string'}
            />
            <label className="checkbox-row nowrap">
              <input
                type="checkbox"
                checked={param.required}
                onChange={(e) => update(index, { ...param, required: e.target.checked })}
              />
              requis
            </label>
            <button
              className="btn ghost sm"
              onClick={() => props.onChange(props.params.filter((_, i) => i !== index))}
            >
              Retirer
            </button>
          </div>
        ))}
      </div>
      <button
        className="btn ghost sm mt-2"
        onClick={() => props.onChange([...props.params, { ...BLANK_PARAM }])}
      >
        <Plus />
        Ajouter un paramètre
      </button>
    </div>
  );
}

function HttpActionFields(props: {
  action: Extract<McpAction, { kind: 'http' }>;
  onChange: (action: McpAction) => void;
}) {
  const { action } = props;
  const set = <K extends keyof typeof action>(key: K, value: (typeof action)[K]) =>
    props.onChange({ ...action, [key]: value });

  const hasBody = action.method !== 'GET' && action.method !== 'DELETE';

  return (
    <>
      <div className="grid cols-2">
        <Field label="Méthode">
          <select
            className="select"
            value={action.method}
            onChange={(e) => set('method', e.target.value as typeof action.method)}
          >
            {(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Délai (ms)">
          <input
            className="input"
            type="number"
            min={1000}
            max={120000}
            value={action.timeoutMs}
            onChange={(e) => set('timeoutMs', Number(e.target.value))}
          />
        </Field>
      </div>

      <Field
        label="URL"
        hint="Le domaine est figé ici. Seuls le chemin, la requête et le corps acceptent des {{paramètres}} : l'agent ne choisit jamais l'hôte appelé."
      >
        <input
          className="input mono"
          value={action.urlTemplate}
          onChange={(e) => set('urlTemplate', e.target.value)}
          placeholder="https://api.exemple.fr/v1/clients/{{siret}}"
        />
      </Field>

      <Field
        label="En-têtes"
        hint="Un par ligne, au format Cle: valeur. Les valeurs enregistrées sont masquées."
      >
        <RawTextarea
          initial={mapToLines(action.headers)}
          rows={2}
          onRaw={(raw) => set('headers', linesToMap(raw))}
          placeholder="authorization: Bearer ..."
        />
      </Field>

      {hasBody && (
        <Field label="Corps" hint="Gabarit JSON, avec les mêmes {{paramètres}}.">
          <textarea
            className="textarea"
            rows={3}
            value={action.bodyTemplate}
            onChange={(e) => set('bodyTemplate', e.target.value)}
            placeholder={'{"siret": "{{siret}}"}'}
          />
        </Field>
      )}

      <Field
        label="Chemin dans la réponse"
        hint="Ex. data.items. Vide : la réponse entière est remise au modèle."
      >
        <input
          className="input mono"
          value={action.responsePath}
          onChange={(e) => set('responsePath', e.target.value)}
          placeholder="data.items"
        />
      </Field>
    </>
  );
}

export { SECRET_MASK };
