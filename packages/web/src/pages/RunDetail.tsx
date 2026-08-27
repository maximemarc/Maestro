/**
 * RunDetail — transcript en direct d'un run (/runs/:id).
 *
 * Le run et ses événements arrivent en temps réel via le store (WebSocket) ;
 * l'API n'est sollicitée que pour l'historique initial et les vieux runs
 * absents du store.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  CaretDown,
  CaretRight,
  CaretUp,
  Check,
  Copy,
  Lock,
  MagnifyingGlass,
  Scroll,
  X,
} from '@phosphor-icons/react';
import { ACTIVE_RUN_STATUSES } from '@maestro/shared';
import type { Run, RunEvent } from '@maestro/shared';
import { api } from '../lib/api';
import {
  fmtCost,
  fmtDateTime,
  fmtDuration,
  fmtTime,
  fmtTokens,
  ORIGIN_LABELS,
} from '../lib/format';
import { selectAgent, useStore } from '../lib/store';
import {
  AgentChip,
  ConfirmButton,
  EmptyState,
  ErrorText,
  Field,
  LoadingBlock,
  Modal,
  Spinner,
  StatusBadge,
} from '../components/ui';

const EMPTY_EVENTS: RunEvent[] = [];
/** Au-delà de cette taille, l'entrée d'un outil est repliée par défaut. */
const TOOL_INPUT_COLLAPSE_CHARS = 400;
/** Marge (px) sous laquelle on considère l'utilisateur « en bas » de la page. */
const AUTO_SCROLL_MARGIN_PX = 60;
const SESSION_DISPLAY_CHARS = 22;
/**
 * Nombre d'événements rendus d'emblée, en partant de la fin.
 *
 * Le store ne plafonne pas `runEvents` — et c'est voulu, on ne jette pas
 * l'historique d'un run. Mais chaque événement est un sous-arbre DOM : un run
 * bavard de plusieurs milliers d'événements rendait la page inutilisable. On
 * borne donc l'affichage, pas la donnée, et le début reste accessible à la
 * demande.
 */
const TRANSCRIPT_WINDOW = 200;

/**
 * Filtres du transcript.
 *
 * Sur un run qui outille beaucoup, le texte de l'agent se noie dans les appels
 * d'outils et leurs résultats. Les trois vues répondent à trois questions
 * distinctes : qu'a dit l'agent, qu'a-t-il fait, qu'est-ce qui a cassé.
 */
type TranscriptFilter = 'all' | 'messages' | 'tools' | 'errors';

const FILTER_LABELS: Record<TranscriptFilter, string> = {
  all: 'Tout',
  messages: 'Messages',
  tools: 'Outils',
  errors: 'Erreurs',
};

const MESSAGE_KINDS = new Set(['init', 'assistant_text', 'thinking', 'result', 'info']);
const TOOL_KINDS = new Set(['tool_use', 'tool_result', 'permission_request', 'permission_result']);

function matchesFilter(ev: RunEvent, filter: TranscriptFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'messages') return MESSAGE_KINDS.has(ev.kind);
  if (filter === 'tools') return TOOL_KINDS.has(ev.kind);
  /* Un résultat d'outil en échec est une erreur, même si son type ne le dit
     pas : c'est ce que l'utilisateur cherche quand il filtre sur « Erreurs ». */
  return ev.kind === 'error' || (ev.kind === 'tool_result' && Boolean(ev.payload.isError));
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fmtMs(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function TranscriptEvent({ ev }: { ev: RunEvent }) {
  const [open, setOpen] = useState(false);
  const p = ev.payload;
  const head = (
    <div className="t-head">
      {fmtTime(ev.ts)} · {ev.kind}
    </div>
  );

  switch (ev.kind) {
    case 'init':
      return (
        <div className="t-event result">
          {head}
          <div>
            Session démarrée. Modèle <strong>{p.model ?? '?'}</strong> · {p.tools?.length ?? 0}{' '}
            outils disponibles
          </div>
        </div>
      );
    case 'assistant_text':
      return (
        <div className="t-event assistant">
          {head}
          <div className="t-body">{p.text ?? ''}</div>
        </div>
      );
    case 'thinking':
      return (
        <div className="t-event thinking">
          {head}
          <button className="btn ghost sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? <CaretDown /> : <CaretRight />}
            Réflexion
          </button>
          {open && <div className="t-body">{p.text ?? ''}</div>}
        </div>
      );
    case 'tool_use': {
      const json = p.toolInput === undefined ? '' : JSON.stringify(p.toolInput, null, 2);
      const collapsible = json.length > TOOL_INPUT_COLLAPSE_CHARS;
      const shown = collapsible && !open ? `${json.slice(0, TOOL_INPUT_COLLAPSE_CHARS)}…` : json;
      return (
        <div className="t-event tool">
          {head}
          <div>
            <strong>{p.toolName ?? 'outil'}</strong>
          </div>
          {json !== '' && <div className="t-body">{shown}</div>}
          {collapsible && (
            <button
              className="btn ghost sm"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
            >
              {open ? 'Replier' : 'Afficher tout'}
            </button>
          )}
        </div>
      );
    }
    case 'tool_result':
      return (
        <div className={`t-event tool${p.isError ? ' error' : ''}`}>
          {head}
          <div>
            <strong>Résultat</strong>
          </div>
          <div className="t-body">{p.text ?? ''}</div>
        </div>
      );
    case 'permission_request':
      return (
        <div className="t-event tool">
          {head}
          <div className="row gap-2">
            <Lock />
            Permission demandée : <strong>{p.toolName ?? '?'}</strong>
          </div>
        </div>
      );
    case 'permission_result':
      return (
        <div className="t-event tool">
          {head}
          <div className="row gap-2">
            <Lock />
            <strong>{p.toolName ?? '?'}</strong>
            <span className={p.decision === 'allowed' ? 'text-ok' : 'text-danger'}>
              {p.decision === 'allowed' ? 'autorisé' : 'refusé'}
            </span>
            {p.resolvedBy ? <span className="text-faint">({p.resolvedBy})</span> : null}
          </div>
        </div>
      );
    case 'result':
      return (
        <div className="t-event result">
          {head}
          <div>
            Tokens : {fmtTokens(p.usage?.inputTokens ?? 0)} entrée /{' '}
            {fmtTokens(p.usage?.outputTokens ?? 0)} sortie · Coût : {fmtCost(p.costUsd ?? 0)} ·
            Tours : {p.numTurns ?? 0} · Durée : {fmtMs(p.durationMs ?? 0)}
          </div>
        </div>
      );
    case 'error':
      return (
        <div className="t-event error">
          {head}
          <div className="t-body">{p.text ?? 'Erreur inconnue'}</div>
        </div>
      );
    default:
      return (
        <div className="t-event">
          {head}
          <div className="text-muted">{p.text ?? ''}</div>
        </div>
      );
  }
}

export default function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const storeRun = useStore((s) => (id ? s.runs.find((r) => r.id === id) : undefined));
  const rawEvents = useStore((s) => (id ? s.runEvents[id] : undefined));
  const approvals = useStore((s) => s.approvals);
  const loadRunEvents = useStore((s) => s.loadRunEvents);

  // Fallback pour un vieux run absent du store ; le store prime (temps réel).
  const [fetchedRun, setFetchedRun] = useState<Run | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [shownCount, setShownCount] = useState(TRANSCRIPT_WINDOW);
  const [filter, setFilter] = useState<TranscriptFilter>('all');
  const [showJump, setShowJump] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumePrompt, setResumePrompt] = useState('');
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const run: Run | null = storeRun ?? fetchedRun;
  const agent = useStore(selectAgent(run?.agentId));
  const events = rawEvents ?? EMPTY_EVENTS;
  const isActive = run ? ACTIVE_RUN_STATUSES.includes(run.status) : false;
  const pendingApproval = run
    ? approvals.find((a) => a.runId === run.id && a.status === 'pending')
    : undefined;

  // Réinitialise l'état local à chaque changement de run.
  useEffect(() => {
    setFetchedRun(null);
    setNotFound(false);
    setError(null);
    setCopied(false);
    setResumeOpen(false);
    setShownCount(TRANSCRIPT_WINDOW);
    setFilter('all');
  }, [id]);

  // Historique du transcript ; la suite arrive en live via le store.
  useEffect(() => {
    if (!id) return;
    loadRunEvents(id).catch((e) => setError(errText(e)));
  }, [id, loadRunEvents]);

  // Fallback : run absent du store (vieux run hors fenêtre des 300 derniers).
  useEffect(() => {
    if (!id) return;
    if (useStore.getState().runs.some((r) => r.id === id)) return;
    let cancelled = false;
    api
      .getRun(id)
      .then(({ run: r }) => {
        if (!cancelled) setFetchedRun(r);
      })
      .catch((e) => {
        if (!cancelled) {
          setNotFound(true);
          setError(errText(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Tick chaque seconde pour la durée d'un run actif.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isActive) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isActive]);

  // Auto-scroll bas sur nouveaux événements si l'utilisateur est déjà en bas.
  const pageRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const onPageScroll = () => {
    const el = pageRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_MARGIN_PX;
    atBottomRef.current = atBottom;
    setShowJump((visible) => (visible === !atBottom ? visible : !atBottom));
  };

  const jumpToBottom = () => {
    const el = pageRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setShowJump(false);
  };
  useEffect(() => {
    const el = pageRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  const cancelRun = async () => {
    if (!run) return;
    try {
      setError(null);
      await api.cancelRun(run.id);
      // Pas de refetch : run.updated arrive par WebSocket.
    } catch (e) {
      setError(errText(e));
    }
  };

  const copyResult = async () => {
    if (!run?.resultText) return;
    try {
      await navigator.clipboard.writeText(run.resultText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setError(`Copie impossible : ${errText(e)}`);
    }
  };

  const submitResume = async () => {
    if (!run || resumePrompt.trim() === '') return;
    setResumeBusy(true);
    setResumeError(null);
    try {
      const newRun = await api.startRun({
        agentId: run.agentId,
        prompt: resumePrompt.trim(),
        resumeRunId: run.id,
      });
      setResumeOpen(false);
      navigate(`/runs/${newRun.id}`);
    } catch (e) {
      setResumeError(errText(e));
    } finally {
      setResumeBusy(false);
    }
  };

  const resolveApproval = async (decision: 'allow' | 'deny') => {
    if (!pendingApproval) return;
    try {
      setError(null);
      await api.resolveApproval(pendingApproval.id, { decision });
      // Pas de refetch : approval.resolved arrive par WebSocket.
    } catch (e) {
      setError(errText(e));
    }
  };

  if (!id) {
    return (
      <div className="page">
        <EmptyState
          icon={<MagnifyingGlass size={28} />}
          title="Run introuvable"
          hint="Identifiant manquant dans l'URL."
        />
      </div>
    );
  }

  const sessionShort = run?.sessionId
    ? run.sessionId.length > SESSION_DISPLAY_CHARS
      ? `${run.sessionId.slice(0, SESSION_DISPLAY_CHARS)}…`
      : run.sessionId
    : null;
  const loading = !run && !notFound;

  /* Fenêtre de rendu : on garde la fin du transcript, c'est là qu'un run en
     cours écrit et c'est ce que l'utilisateur vient lire. */
  const filteredEvents =
    filter === 'all' ? events : events.filter((ev) => matchesFilter(ev, filter));
  const visibleEvents =
    filteredEvents.length > shownCount
      ? filteredEvents.slice(filteredEvents.length - shownCount)
      : filteredEvents;
  const hiddenCount = filteredEvents.length - visibleEvents.length;

  return (
    <div className="page" ref={pageRef} onScroll={onPageScroll}>
      <div className="page-header">
        <Link to="/runs" className="btn ghost sm">
          <ArrowLeft />
          Runs
        </Link>
        <h1>
          Run <span className="mono">{id.slice(0, 8)}</span>
        </h1>
      </div>

      {error && <ErrorText>{error}</ErrorText>}

      {loading && (
        <div className="card">
          <LoadingBlock label="Chargement du run…" rows={4} />
        </div>
      )}

      {!run && notFound && (
        <EmptyState
          icon={<MagnifyingGlass size={28} />}
          title="Run introuvable"
          hint="Ce run n'existe pas ou a été purgé."
        />
      )}

      {run && (
        <div className="col gap-4">
          <div className="card">
            <div className="row wrap">
              <StatusBadge status={run.status} />
              <AgentChip agent={agent} />
              <span className="badge violet">{ORIGIN_LABELS[run.origin] ?? run.origin}</span>
              <span className="badge">{run.model}</span>
              <span className="badge">{run.engine}</span>
              <div className="row gap-2 ml-auto wrap">
                {isActive && (
                  <ConfirmButton
                    label="Annuler"
                    title="Annuler ce run ?"
                    message="Le run et les runs qu'il a délégués seront interrompus. Le travail déjà effectué reste dans le transcript."
                    confirmLabel="Annuler le run"
                    onConfirm={() => void cancelRun()}
                  />
                )}
                {run.status === 'succeeded' && (
                  <button
                    className="btn primary sm"
                    onClick={() => {
                      setResumePrompt('');
                      setResumeError(null);
                      setResumeOpen(true);
                    }}
                  >
                    Relancer une suite
                  </button>
                )}
                {run.resultText && (
                  <button className="btn sm" onClick={copyResult}>
                    {copied ? <Check /> : <Copy />}
                    {copied ? 'Copié' : 'Copier le résultat'}
                  </button>
                )}
              </div>
            </div>
            <dl className="kv mt-4">
              <dt>Session</dt>
              <dd className="mono" title={run.sessionId ?? undefined}>
                {sessionShort ?? <span className="text-faint">aucune</span>}
              </dd>
              <dt>Tours</dt>
              <dd>{run.numTurns}</dd>
              <dt>Tokens</dt>
              <dd>
                {fmtTokens(run.inputTokens)} entrée · {fmtTokens(run.outputTokens)} sortie ·{' '}
                {fmtTokens(run.cacheReadTokens)} cache
              </dd>
              <dt>Coût</dt>
              <dd>{fmtCost(run.costUsd)}</dd>
              <dt>Durée</dt>
              <dd>{fmtDuration(run.startedAt, run.endedAt)}</dd>
              <dt>Créé</dt>
              <dd>{fmtDateTime(run.createdAt)}</dd>
              <dt>Terminé</dt>
              <dd>{fmtDateTime(run.endedAt)}</dd>
            </dl>
          </div>

          {run.tmuxSession && (
            <div className="card">
              <h3>Session tmux</h3>
              <p className="text-muted text-sm mb-2">Attache-toi depuis un terminal :</p>
              <code className="mono">tmux attach -t {run.tmuxSession}</code>
            </div>
          )}

          {pendingApproval && (
            <div className="card attention approval-sticky" role="alert">
              <div className="row wrap">
                <span className="badge warn">Approbation requise</span>
                <strong>{pendingApproval.toolName}</strong>
                <div className="row gap-2 ml-auto">
                  <button className="btn ok sm" onClick={() => resolveApproval('allow')}>
                    <Check />
                    Autoriser
                  </button>
                  <button className="btn danger sm" onClick={() => resolveApproval('deny')}>
                    <X />
                    Refuser
                  </button>
                </div>
              </div>
              <pre className="scroll-box break-word mt-3">
                {pendingApproval.input === undefined
                  ? ''
                  : JSON.stringify(pendingApproval.input, null, 2)}
              </pre>
            </div>
          )}

          <section aria-label="Transcript du run">
            <div className="row justify-between wrap">
              <h3>Transcript</h3>
              {events.length > 0 && (
                <div className="row gap-2 wrap">
                  <div className="row gap-1" role="group" aria-label="Filtrer le transcript">
                    {(Object.keys(FILTER_LABELS) as TranscriptFilter[]).map((value) => (
                      <button
                        key={value}
                        className={`btn sm${filter === value ? ' primary' : ' ghost'}`}
                        onClick={() => setFilter(value)}
                        aria-pressed={filter === value}
                      >
                        {FILTER_LABELS[value]}
                      </button>
                    ))}
                  </div>
                  <span className="text-faint text-xs num">
                    {filteredEvents.length}
                    {filter === 'all' ? '' : ` / ${events.length}`} événement
                    {events.length > 1 ? 's' : ''}
                  </span>
                </div>
              )}
            </div>
            {filteredEvents.length === 0 ? (
              <EmptyState
                icon={<Scroll size={28} />}
                title={events.length === 0 ? 'Aucun événement' : 'Aucun événement de ce type'}
                hint={
                  events.length === 0
                    ? "Le transcript se remplit en direct dès que l'agent travaille."
                    : 'Repasse sur « Tout » pour voir le transcript complet.'
                }
              />
            ) : (
              <div className="transcript">
                {hiddenCount > 0 && (
                  <div className="row gap-2 wrap justify-center">
                    <button
                      className="btn sm"
                      onClick={() => setShownCount((n) => n + TRANSCRIPT_WINDOW)}
                    >
                      <CaretUp />
                      Afficher les {Math.min(hiddenCount, TRANSCRIPT_WINDOW)} événements précédents
                    </button>
                    <button
                      className="btn ghost sm"
                      onClick={() => setShownCount(filteredEvents.length)}
                      title={`${hiddenCount} événements plus anciens sont masqués`}
                    >
                      Tout afficher ({hiddenCount})
                    </button>
                  </div>
                )}
                {visibleEvents.map((ev) => (
                  <TranscriptEvent key={ev.id} ev={ev} />
                ))}
              </div>
            )}
          </section>

          {run.resultText && (
            <div className="card card-ok">
              <h3>Résultat final</h3>
              <div className="pre-wrap prose">{run.resultText}</div>
            </div>
          )}
        </div>
      )}

      {showJump && events.length > 0 && (
        <button className="btn jump-bottom" onClick={jumpToBottom}>
          <CaretDown />
          Revenir en bas
        </button>
      )}

      {resumeOpen && run && (
        <Modal title="Relancer une suite" onClose={() => setResumeOpen(false)}>
          <Field
            label="Prompt de suite"
            hint="La session Claude Code de ce run sera reprise (contexte conservé)."
          >
            <textarea
              className="textarea"
              value={resumePrompt}
              onChange={(e) => setResumePrompt(e.target.value)}
              placeholder="Que doit faire l'agent ensuite ?"
              data-autofocus
            />
          </Field>
          {resumeError && <ErrorText>{resumeError}</ErrorText>}
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setResumeOpen(false)}>
              Annuler
            </button>
            <button
              className="btn primary"
              disabled={resumeBusy || resumePrompt.trim() === ''}
              onClick={submitResume}
            >
              {resumeBusy && <Spinner />}
              {resumeBusy ? 'Lancement…' : 'Lancer'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
