import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  Books,
  ChartLine,
  Clock,
  Faders,
  FlowArrow,
  Gauge,
  Gear,
  Kanban,
  Lightning,
  List,
  MagnifyingGlass,
  Package,
  Plug,
  PuzzlePiece,
  Radio,
  Robot,
  ShieldCheck,
  SidebarSimple,
  type Icon,
} from '@phosphor-icons/react';
import { IconContext } from '@phosphor-icons/react';
import { getToken } from './lib/api';
import { fmtCost, fmtTokens, fmtUptime } from './lib/format';
import { useStore } from './lib/store';
import { connectWs, disconnectWs } from './lib/ws';
import { CommandPalette, type PaletteEntry } from './components/CommandPalette';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastHost } from './components/ToastHost';
import { canNotify, notifyApprovalsEnabled } from './lib/prefs';
import { LoadingBlock } from './components/ui';
import LoginPage from './pages/LoginPage';

/**
 * Pages chargées à la demande.
 *
 * Tout était auparavant dans un seul paquet : ouvrir Mission Control
 * téléchargeait aussi le moteur de graphe d3-force, le canvas du radar, les
 * graphiques et le catalogue distant, dont on n'a besoin que sur trois pages.
 * Le découpage par route ne change rien à la navigation et allège le premier
 * écran, qui est le seul que l'utilisateur attend.
 */
const MissionControl = lazy(() => import('./pages/MissionControl'));
const RadarPage = lazy(() => import('./pages/RadarPage'));
const AgentsPage = lazy(() => import('./pages/AgentsPage'));
const AgentDetail = lazy(() => import('./pages/AgentDetail'));
const RunsPage = lazy(() => import('./pages/RunsPage'));
const RunDetail = lazy(() => import('./pages/RunDetail'));
const KanbanPage = lazy(() => import('./pages/KanbanPage'));
const ApprovalsPage = lazy(() => import('./pages/ApprovalsPage'));
const SkillsPage = lazy(() => import('./pages/SkillsPage'));
const RoutinesPage = lazy(() => import('./pages/RoutinesPage'));
const PipelinesPage = lazy(() => import('./pages/PipelinesPage'));
const PluginsPage = lazy(() => import('./pages/PluginsPage'));
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage'));
const McpPage = lazy(() => import('./pages/McpPage'));
const RagPage = lazy(() => import('./pages/RagPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));

interface NavItem {
  to: string;
  icon: Icon;
  label: string;
  end?: boolean;
}

/**
 * Iconographie : Phosphor, une seule famille, une seule graisse (réglée par
 * IconContext plus bas). L'emoji ne tient plus lieu d'icône — il ne se met pas
 * à la couleur du texte, ne s'aligne pas sur la ligne de base et diffère d'un
 * système d'exploitation à l'autre. Il subsiste là où c'est une donnée saisie
 * par l'utilisateur : l'avatar d'un agent.
 */
const NAV: NavItem[] = [
  { to: '/', icon: Gauge, label: 'Mission Control', end: true },
  { to: '/radar', icon: Radio, label: 'Radar' },
  { to: '/agents', icon: Robot, label: 'Agents' },
  { to: '/runs', icon: Lightning, label: 'Runs' },
  { to: '/kanban', icon: Kanban, label: 'Kanban' },
  { to: '/approvals', icon: ShieldCheck, label: 'Approbations' },
  { to: '/skills', icon: Package, label: 'Skills' },
  { to: '/mcp', icon: Plug, label: 'MCP' },
  { to: '/rag', icon: Books, label: 'RAG' },
  { to: '/routines', icon: Clock, label: 'Routines' },
  { to: '/pipelines', icon: FlowArrow, label: 'Pipelines' },
  { to: '/plugins', icon: PuzzlePiece, label: 'Plugins' },
  { to: '/analytics', icon: ChartLine, label: 'Analytique' },
  { to: '/settings', icon: Gear, label: 'Paramètres' },
];

const RAIL_KEY = 'maestro:nav-rail';

/** Au-dessous de cette largeur, la barre latérale ne peut pas rester dépliée. */
const RAIL_FORCED_BELOW = 1280;

/**
 * Squelette d'attente : il prend la forme d'une page pour que l'arrivée du
 * contenu ne décale rien. Un simple mot « Chargement » laisse un écran vide,
 * et un écran vide ressemble à une panne.
 */
function PageSkeleton() {
  return (
    <div className="page">
      <div className="grid cols-3 mb-4">
        <div className="card">
          <LoadingBlock label="Chargement…" rows={3} />
        </div>
        <div className="card">
          <LoadingBlock rows={3} />
        </div>
        <div className="card">
          <LoadingBlock rows={3} />
        </div>
      </div>
      <div className="card">
        <LoadingBlock rows={6} />
      </div>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  const navigate = useNavigate();
  const location = useLocation();
  const connected = useStore((s) => s.connected);
  const bootstrapped = useStore((s) => s.bootstrapped);
  const metrics = useStore((s) => s.metrics);
  const server = useStore((s) => s.server);
  const agents = useStore((s) => s.agents);
  const runs = useStore((s) => s.runs);
  const skills = useStore((s) => s.skills);
  // Dérive un primitif : un sélecteur qui retourne un tableau neuf à chaque
  // snapshot provoque une boucle de rendu infinie (zustand v5 + React 19).
  const pendingApprovalsCount = useStore((s) =>
    s.approvals.reduce((n, a) => (a.status === 'pending' ? n + 1 : n), 0),
  );
  const approvals = useStore((s) => s.approvals);
  const bootstrap = useStore((s) => s.bootstrap);

  /* La barre latérale se replie en rail. Le choix est mémorisé : c'est un
     réglage de poste de travail, pas une préférence de session. */
  const [railPref, setRailPref] = useState(() => localStorage.getItem(RAIL_KEY) === '1');
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < RAIL_FORCED_BELOW,
  );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const rail = railPref || narrow;

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${RAIL_FORCED_BELOW - 1}px)`);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const toggleRail = useCallback(() => {
    setRailPref((v) => {
      const next = !v;
      localStorage.setItem(RAIL_KEY, next ? '1' : '0');
      return next;
    });
  }, []);

  /* Changer de page ferme le tiroir mobile : sinon il masque la page qu'on
     vient d'ouvrir. */
  useEffect(() => {
    setMobileNavOpen(false);
    setPaletteOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const base = 'Maestro, poste de commandement';
    document.title = pendingApprovalsCount > 0 ? `(${pendingApprovalsCount}) ${base}` : base;
  }, [pendingApprovalsCount]);

  /* Alerte système sur nouvelle demande, si l'utilisateur l'a activée dans les
     paramètres. On suit les identifiants déjà vus plutôt que le compteur : une
     demande résolue et une nouvelle arrivée laissent le compteur inchangé. */
  const seenApprovalIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!authed) return;
    const pending = approvals.filter((a) => a.status === 'pending');
    const ids = new Set(pending.map((a) => a.id));

    /* Premier passage : on enregistre l'existant sans notifier, sinon
       l'ouverture de l'application déclenche une alerte par demande en cours. */
    if (seenApprovalIds.current === null) {
      seenApprovalIds.current = ids;
      return;
    }

    const known = seenApprovalIds.current;
    if (notifyApprovalsEnabled() && canNotify()) {
      for (const approval of pending) {
        if (known.has(approval.id)) continue;
        const agent = agents.find((a) => a.id === approval.agentId);
        new Notification('Approbation requise', {
          body: `${agent?.name ?? 'Un agent'} demande ${approval.toolName}`,
          tag: approval.id,
        });
      }
    }
    seenApprovalIds.current = ids;
  }, [approvals, agents, authed]);

  useEffect(() => {
    const onUnauthorized = () => {
      setAuthed(false);
      disconnectWs();
    };
    window.addEventListener('maestro:unauthorized', onUnauthorized);
    return () => window.removeEventListener('maestro:unauthorized', onUnauthorized);
  }, []);

  /* Ctrl/⌘ + K ouvre la palette de commandes, partout dans l'application. */
  useEffect(() => {
    if (!authed) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.code === 'KeyK' && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    connectWs();
    bootstrap().catch(() => {
      /* le gestionnaire 401 gère la déconnexion */
    });
    return () => disconnectWs();
  }, [authed, bootstrap]);

  const paletteEntries = useMemo<PaletteEntry[]>(
    () =>
      NAV.map((item) => {
        const ItemIcon = item.icon;
        return {
          id: `nav-${item.to}`,
          group: 'Pages',
          label: item.label,
          icon: <ItemIcon />,
          to: item.to,
        };
      }),
    [],
  );

  const handlePalettePick = useCallback(
    (to: string) => {
      setPaletteOpen(false);
      navigate(to);
    },
    [navigate],
  );

  if (!authed) {
    return (
      <LoginPage
        onLogin={() => {
          setAuthed(true);
          navigate('/');
        }}
      />
    );
  }

  const tokensToday = (metrics?.todayInputTokens ?? 0) + (metrics?.todayOutputTokens ?? 0);

  return (
    /* Une seule famille d'icônes, une seule graisse, une seule taille par
       défaut : sans ce réglage global, chaque page dérive. */
    <IconContext.Provider value={{ size: 16, weight: 'regular' }}>
      <div
        className="app-shell"
        data-rail={rail ? 'true' : 'false'}
        data-mobile-nav={mobileNavOpen ? 'open' : 'closed'}
      >
        <a className="skip-link" href="#contenu">
          Aller au contenu
        </a>

        <button
          className="nav-scrim"
          onClick={() => setMobileNavOpen(false)}
          aria-label="Fermer la navigation"
          tabIndex={mobileNavOpen ? 0 : -1}
        />

        <aside className="sidebar" aria-label="Navigation principale">
          <div className="sidebar-brand">
            <span className="brand-mark">
              <Faders size={20} />
            </span>
            <span className="brand-label">Maestro</span>
            <span
              className={`link-state${connected ? '' : ' off'}`}
              role="status"
              aria-label={
                connected ? 'Liaison temps réel active' : 'Liaison temps réel interrompue'
              }
              title={connected ? 'Liaison temps réel active' : 'Liaison temps réel interrompue'}
            />
          </div>

          {NAV.map((item) => {
            const ItemIcon = item.icon;
            const showCount = item.to === '/approvals' && pendingApprovalsCount > 0;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
                title={rail ? item.label : undefined}
              >
                <span className="nav-icon">
                  <ItemIcon />
                </span>
                <span className="nav-label">{item.label}</span>
                {showCount && (
                  <span className="count" aria-label={`${pendingApprovalsCount} en attente`}>
                    {pendingApprovalsCount}
                  </span>
                )}
              </NavLink>
            );
          })}

          <div className="sidebar-footer">
            <button
              className="sidebar-collapse"
              onClick={toggleRail}
              aria-label={rail ? 'Déplier la navigation' : 'Replier la navigation'}
              title={rail ? 'Déplier la navigation' : 'Replier la navigation'}
            >
              <SidebarSimple size={16} />
            </button>
            <span className="footer-text">v{server?.version ?? '…'}</span>
          </div>
        </aside>

        {/* tabIndex -1 : la zone n'est pas dans l'ordre de tabulation, elle
            sert uniquement de cible au lien d'évitement. */}
        <main className="main" id="contenu" tabIndex={-1}>
          <div className="topbar">
            <button
              className="btn ghost sm icon nav-toggle"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Ouvrir la navigation"
            >
              <List size={18} />
            </button>

            {/* Hiérarchie : ce qui appelle une décision d'abord, le contexte
                ensuite. Six chiffres de même poids, c'est six chiffres qu'on
                ne lit plus. */}
            <span className="stat-chip">
              Runs actifs <b>{metrics?.activeRuns ?? 0}</b>
            </span>
            <span className="stat-chip">
              En file <b>{metrics?.queuedRuns ?? 0}</b>
            </span>
            {pendingApprovalsCount > 0 && (
              <span className="stat-chip alert">
                À approuver <b>{pendingApprovalsCount}</b>
              </span>
            )}
            <span className="stat-chip secondary">
              Débit <b>{metrics?.eventsPerSec ?? 0}</b> évt/s
            </span>
            <span className="stat-chip ctx">
              Tokens <b>{fmtTokens(tokensToday)}</b>
            </span>
            <span className="stat-chip ctx">
              Coût <b>{fmtCost(metrics?.todayCostUsd ?? 0)}</b>
            </span>

            <span className="spacer" />

            {/* La perte de liaison est dite, pas seulement colorée : sans ce
                message, une page figée passe pour une page vide. */}
            {!connected && (
              <span className="badge warn" role="status">
                Reconnexion…
              </span>
            )}

            <span className="stat-chip ctx">
              Uptime <b>{fmtUptime(metrics?.uptimeSec ?? 0)}</b>
            </span>

            <button
              className="palette-trigger"
              onClick={() => setPaletteOpen(true)}
              aria-label="Ouvrir la palette de commandes"
            >
              <MagnifyingGlass size={14} />
              <span className="nowrap">Aller à</span>
              <kbd>Ctrl K</kbd>
            </button>
          </div>

          {bootstrapped ? (
            /* Le squelette sert deux attentes de même nature : le bootstrap du
               store, et le téléchargement du module d'une page. */
            <ErrorBoundary resetKey={location.pathname}>
              <Suspense fallback={<PageSkeleton />}>
                <Routes>
                  <Route path="/" element={<MissionControl />} />
                  <Route path="/radar" element={<RadarPage />} />
                  <Route path="/agents" element={<AgentsPage />} />
                  <Route path="/agents/:id" element={<AgentDetail />} />
                  <Route path="/runs" element={<RunsPage />} />
                  <Route path="/runs/:id" element={<RunDetail />} />
                  <Route path="/kanban" element={<KanbanPage />} />
                  <Route path="/approvals" element={<ApprovalsPage />} />
                  <Route path="/skills" element={<SkillsPage />} />
                  <Route path="/mcp" element={<McpPage />} />
                  <Route path="/rag" element={<RagPage />} />
                  <Route path="/routines" element={<RoutinesPage />} />
                  <Route path="/pipelines" element={<PipelinesPage />} />
                  <Route path="/plugins" element={<PluginsPage />} />
                  <Route path="/analytics" element={<AnalyticsPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                </Routes>
              </Suspense>
            </ErrorBoundary>
          ) : (
            <PageSkeleton />
          )}
        </main>

        <ToastHost />

        {paletteOpen && (
          <CommandPalette
            entries={paletteEntries}
            agents={agents}
            runs={runs}
            skills={skills}
            onClose={() => setPaletteOpen(false)}
            onPick={handlePalettePick}
          />
        )}
      </div>
    </IconContext.Provider>
  );
}
