/**
 * Graphe force-directed des agents (canvas 2D + d3-force), style Obsidian.
 * Topologie hiérarchique : hub central fixe « Maestro » → agents de premier
 * niveau → subagents (via `parentAgentId`), impulsions animées sur les
 * événements de runs, drag pour épingler (pinned), double-clic pour libérer.
 */
import {
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type ForceCenter,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import type { AgentConfig, RunEvent } from '@maestro/shared';
import { canvasFont, canvasTokens } from '../../lib/theme';

const HUB_ID = '__hub__';
const HUB_R = 28;
const NODE_R = 24;
const SUB_R = 19;
const COLLIDE_PAD = 16;
/** Dégagement autour du hub : il est fixe, c'est à lui d'imposer la distance. */
const HUB_CLEARANCE = 48;
const PULSE_MS = 800;
/* Le lien hub → premier niveau est plus long que parent → subagent : c'est ce
   rapport de longueurs qui rend la hiérarchie lisible sans flèche ni étiquette. */
const LINK_DISTANCE = 200;
const SUB_LINK_DISTANCE = 120;
const DRAG_THRESHOLD_PX = 4;
const MAX_PULSES = 80;
/* Garde-fou de remontée de chaîne : la topologie attendue tient en 3 niveaux. */
const MAX_DEPTH = 6;

/**
 * Couleurs et polices : lues depuis la feuille de style, pas recopiées.
 *
 * Un canvas ne connaît pas les variables CSS. La tentation est de recopier les
 * valeurs ici — c'est ce que faisait ce fichier, et la palette a fini par
 * dériver de celle de l'interface sans que rien ne le signale. `canvasTokens`
 * lit les jetons une fois et les mémorise ; l'appel est donc gratuit dans la
 * boucle de rendu.
 */
const palette = canvasTokens;

/**
 * Marque du hub : trois curseurs, comme l'icône de l'application. Dessinée
 * plutôt qu'écrite : un emoji change de forme, de taille et d'alignement selon
 * le système, au centre exact du graphe.
 */
function drawFadersMark(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  const half = 8;
  const knobs = [-0.35, 0.2, -0.1];
  ctx.save();
  ctx.strokeStyle = palette().accent;
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const x = cx + (i - 1) * 6;
    ctx.beginPath();
    ctx.moveTo(x, cy - half);
    ctx.lineTo(x, cy + half);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, cy + knobs[i]! * half * 2, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = palette().accent;
    ctx.fill();
  }
  ctx.restore();
}

interface GraphNode extends SimulationNodeDatum {
  id: string;
  x: number;
  y: number;
  /** 0 = hub, 1 = agent de premier niveau, ≥ 2 = subagent. */
  depth: number;
  /** Parent effectif dans le graphe (HUB_ID compris) ; null pour le hub. */
  parentId: string | null;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  /** Profondeur de la cible : porte la distance et le rendu du lien. */
  depth: number;
}

interface Pulse {
  agentId: string;
  /** true = agent → parent (résultat), false = parent → agent (message). */
  toParent: boolean;
  color: string;
  start: number;
}

interface AgentGraphProps {
  agents: AgentConfig[];
  activeAgentIds: ReadonlySet<string>;
  selectedId: string | null;
  liveEvents: RunEvent[];
  onSelect: (id: string | null) => void;
  onPin: (id: string, pinned: { x: number; y: number } | null) => void;
}

const nodeRadius = (depth: number): number => (depth <= 0 ? HUB_R : depth === 1 ? NODE_R : SUB_R);

/**
 * Résout la hiérarchie affichée : parent effectif et profondeur de chaque agent.
 * Un parent inconnu, archivé ou pris dans un cycle est remplacé par le hub —
 * sans ça une donnée incohérente ferait boucler le calcul de profondeur.
 */
function resolveHierarchy(agents: AgentConfig[]): {
  parentOf: Map<string, string>;
  depthOf: Map<string, number>;
} {
  const linkable = new Map<string, AgentConfig>();
  for (const agent of agents) {
    if (!agent.archived) linkable.set(agent.id, agent);
  }

  const rawParent = (id: string): string | null => {
    const parent = linkable.get(id)?.parentAgentId ?? null;
    return parent !== null && parent !== id && linkable.has(parent) ? parent : null;
  };

  const parentOf = new Map<string, string>();
  for (const agent of agents) {
    let parent = rawParent(agent.id);
    const seen = new Set<string>([agent.id]);
    let cursor = parent;
    while (cursor !== null) {
      if (seen.has(cursor)) {
        parent = null;
        break;
      }
      seen.add(cursor);
      cursor = rawParent(cursor);
    }
    parentOf.set(agent.id, parent ?? HUB_ID);
  }

  const depthOf = new Map<string, number>();
  for (const agent of agents) {
    let depth = 1;
    let cursor = parentOf.get(agent.id) ?? HUB_ID;
    while (cursor !== HUB_ID && depth < MAX_DEPTH) {
      depth++;
      cursor = parentOf.get(cursor) ?? HUB_ID;
    }
    depthOf.set(agent.id, depth);
  }

  return { parentOf, depthOf };
}

export default function AgentGraph(props: AgentGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  const simRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);
  const centerForceRef = useRef<ForceCenter<GraphNode> | null>(null);
  const nodesRef = useRef<GraphNode[]>([]);
  const sizeRef = useRef({ w: 0, h: 0 });
  const pulsesRef = useRef<Pulse[]>([]);
  const dragRef = useRef<{ id: string; moved: boolean; sx: number; sy: number } | null>(null);
  const lastEventIdRef = useRef<number | null>(null);

  /* Doit rester le premier effet : les suivants lisent propsRef. */
  useEffect(() => {
    propsRef.current = props;
  });

  /* Canvas : taille (ResizeObserver + devicePixelRatio) et boucle de rendu RAF. */
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const syncSize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      sizeRef.current = { w: rect.width, h: rect.height };
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      centerForceRef.current?.x(cx).y(cy);
      const hub = nodesRef.current.find((n) => n.id === HUB_ID);
      if (hub) {
        hub.fx = cx;
        hub.fy = cy;
      }
      /* Les positions épinglées sont relatives au centre : re-fixe après resize. */
      for (const agent of propsRef.current.agents) {
        if (!agent.pinned) continue;
        const node = nodesRef.current.find((n) => n.id === agent.id);
        if (node) {
          node.fx = cx + agent.pinned.x;
          node.fy = cy + agent.pinned.y;
        }
      }
      simRef.current?.alpha(0.3).restart();
    };

    syncSize();
    const observer = new ResizeObserver(syncSize);
    observer.observe(container);

    // Le CSS ne peut rien pour un canvas : on interroge la même préférence.
    const calmMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let raf = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const { w, h } = sizeRef.current;
      if (w === 0 || h === 0) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const { agents, activeAgentIds, selectedId } = propsRef.current;
      const agentById = new Map(agents.map((a) => [a.id, a]));
      const nodes = nodesRef.current;
      const nodeById = new Map(nodes.map((n) => [n.id, n]));
      const hub = nodeById.get(HUB_ID);

      /* Liens node → parent. Le lien vers un subagent est plus fin et plus sombre :
         l'œil sépare ainsi les deux niveaux sans flèche ni étiquette. */
      for (const node of nodes) {
        if (node.parentId === null) continue;
        const parent = nodeById.get(node.parentId);
        if (!parent) continue;
        const isSub = node.depth > 1;
        ctx.strokeStyle = isSub ? palette().bgHover : palette().border;
        ctx.lineWidth = isSub ? 0.75 : 1;
        ctx.beginPath();
        ctx.moveTo(parent.x, parent.y);
        ctx.lineTo(node.x, node.y);
        ctx.stroke();
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      /* Nœuds agents. */
      for (const node of nodes) {
        if (node.id === HUB_ID) continue;
        const agent = agentById.get(node.id);
        if (!agent) continue;
        const isSub = node.depth > 1;
        const r = nodeRadius(node.depth);

        if (activeAgentIds.has(agent.id)) {
          /* Halo pulsant : run actif. */
          ctx.beginPath();
          ctx.arc(node.x, node.y, r + 6, 0, Math.PI * 2);
          ctx.strokeStyle = agent.color;
          // Halo fixe en mouvement réduit : le run actif reste signalé, sans pulsation.
          ctx.globalAlpha = calmMotion ? 0.4 : 0.2 + 0.35 * (0.5 + 0.5 * Math.sin(now / 220));
          ctx.lineWidth = 4;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.fillStyle = palette().bgElevated;
        ctx.fill();
        ctx.strokeStyle = agent.color;
        ctx.lineWidth = 2;
        ctx.stroke();

        if (selectedId === agent.id) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, r + 9, 0, Math.PI * 2);
          ctx.strokeStyle = palette().accent;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        if (agent.pinned) {
          ctx.beginPath();
          ctx.arc(node.x + r * 0.75, node.y - r * 0.75, 3, 0, Math.PI * 2);
          ctx.fillStyle = palette().textMuted;
          ctx.fill();
        }

        ctx.font = isSub ? canvasFont(15, true) : canvasFont(20, true);
        ctx.fillStyle = palette().text;
        ctx.fillText(agent.emoji, node.x, node.y + 1);

        ctx.font = isSub ? canvasFont(10) : canvasFont(11);
        ctx.fillStyle = palette().textMuted;
        const maxChars = isSub ? 13 : 16;
        const label =
          agent.name.length > maxChars ? `${agent.name.slice(0, maxChars - 1)}…` : agent.name;
        ctx.fillText(label, node.x, node.y + r + (isSub ? 11 : 13));
      }

      /* Hub central. */
      if (hub) {
        ctx.beginPath();
        ctx.arc(hub.x, hub.y, HUB_R, 0, Math.PI * 2);
        ctx.fillStyle = palette().bgElevated;
        ctx.fill();
        ctx.strokeStyle = palette().accent;
        ctx.lineWidth = 2;
        ctx.stroke();
        drawFadersMark(ctx, hub.x, hub.y);
        ctx.font = canvasFont(11);
        ctx.fillStyle = palette().textMuted;
        ctx.fillText('Maestro', hub.x, hub.y - HUB_R - 10);
      }

      /* Impulsions (flux de messages) : elles suivent l'arête réelle du graphe,
         donc parent ↔ agent, le parent étant un agent ou le hub. En mouvement
         réduit, on les vide au lieu de les animer — l'information reste dans le
         journal et dans l'état des nœuds. */
      if (calmMotion) pulsesRef.current.length = 0;
      const pulses = pulsesRef.current;
      for (let i = pulses.length - 1; i >= 0; i--) {
        const pulse = pulses[i];
        if (!pulse) continue;
        const t = (now - pulse.start) / PULSE_MS;
        const target = nodeById.get(pulse.agentId);
        const parent = target ? nodeById.get(target.parentId ?? HUB_ID) : undefined;
        if (t >= 1 || !target || !parent) {
          pulses.splice(i, 1);
          continue;
        }
        const from = pulse.toParent ? target : parent;
        const to = pulse.toParent ? parent : target;
        const px = from.x + (to.x - from.x) * t;
        const py = from.y + (to.y - from.y) * t;
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fillStyle = pulse.color;
        ctx.shadowColor = pulse.color;
        ctx.shadowBlur = 10;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      simRef.current?.stop();
      simRef.current = null;
      centerForceRef.current = null;
      nodesRef.current = [];
      pulsesRef.current = [];
    };
  }, []);

  /* (Re)construit la simulation quand la liste d'agents ou la hiérarchie change :
     un changement de parent doit reconstruire les liens, d'où sa présence en clé. */
  const idsKey = props.agents
    .map((a) => `${a.id}>${a.parentAgentId ?? '-'}${a.archived ? '!' : ''}`)
    .join('|');
  useEffect(() => {
    const { w, h } = sizeRef.current;
    const cx = w / 2;
    const cy = h / 2;
    const agents = propsRef.current.agents;
    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    const { parentOf, depthOf } = resolveHierarchy(agents);

    const hub: GraphNode = prev.get(HUB_ID) ?? {
      id: HUB_ID,
      x: cx,
      y: cy,
      depth: 0,
      parentId: null,
    };
    hub.fx = cx;
    hub.fy = cy;
    const nodes: GraphNode[] = [hub];
    agents.forEach((agent, i) => {
      const depth = depthOf.get(agent.id) ?? 1;
      const parentId = parentOf.get(agent.id) ?? HUB_ID;
      const angle = (i / Math.max(1, agents.length)) * Math.PI * 2;
      const ring = depth === 1 ? LINK_DISTANCE : LINK_DISTANCE + SUB_LINK_DISTANCE;
      const node: GraphNode = prev.get(agent.id) ?? {
        id: agent.id,
        x: cx + Math.cos(angle) * ring,
        y: cy + Math.sin(angle) * ring,
        depth,
        parentId,
      };
      node.depth = depth;
      node.parentId = parentId;
      if (agent.pinned) {
        node.fx = cx + agent.pinned.x;
        node.fy = cy + agent.pinned.y;
      } else if (dragRef.current?.id !== agent.id) {
        node.fx = null;
        node.fy = null;
      }
      nodes.push(node);
    });
    nodesRef.current = nodes;

    const links: GraphLink[] = agents.map((a) => ({
      source: parentOf.get(a.id) ?? HUB_ID,
      target: a.id,
      depth: depthOf.get(a.id) ?? 1,
    }));
    const linkForce = forceLink<GraphNode, GraphLink>(links)
      .id((n) => n.id)
      .distance((link) => (link.depth > 1 ? SUB_LINK_DISTANCE : LINK_DISTANCE));

    const sim = simRef.current;
    if (!sim) {
      const center = forceCenter<GraphNode>(cx, cy);
      centerForceRef.current = center;
      simRef.current = forceSimulation<GraphNode, GraphLink>(nodes)
        .force('charge', forceManyBody<GraphNode>().strength(-300))
        .force(
          'collide',
          forceCollide<GraphNode>(
            (n) => nodeRadius(n.depth) + (n.depth === 0 ? HUB_CLEARANCE : COLLIDE_PAD),
          ),
        )
        .force('center', center)
        .force('link', linkForce);
    } else {
      sim.nodes(nodes);
      sim.force('link', linkForce);
      sim.alpha(0.6).restart();
    }
  }, [idsKey]);

  /* Synchronise les positions épinglées venues du serveur (autres clients). */
  const pinKey = props.agents
    .map((a) => `${a.id}:${a.pinned ? `${a.pinned.x},${a.pinned.y}` : '-'}`)
    .join('|');
  useEffect(() => {
    const { w, h } = sizeRef.current;
    for (const agent of propsRef.current.agents) {
      if (dragRef.current?.id === agent.id) continue;
      const node = nodesRef.current.find((n) => n.id === agent.id);
      if (!node) continue;
      if (agent.pinned) {
        node.fx = w / 2 + agent.pinned.x;
        node.fy = h / 2 + agent.pinned.y;
      } else {
        node.fx = null;
        node.fy = null;
      }
    }
  }, [pinKey]);

  /* Nouveaux événements live → impulsions animées. */
  useEffect(() => {
    const events = props.liveEvents;
    const prevId = lastEventIdRef.current;
    const last = events[events.length - 1];
    lastEventIdRef.current = last ? last.id : (prevId ?? 0);
    if (prevId === null) return; // backlog initial : pas d'animation
    const agentById = new Map(props.agents.map((a) => [a.id, a]));
    const now = performance.now();
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (!ev || ev.id <= prevId) break;
      const agent = agentById.get(ev.agentId);
      if (!agent) continue;
      pulsesRef.current.push(
        ev.kind === 'result'
          ? { agentId: ev.agentId, toParent: true, color: palette().ok, start: now }
          : { agentId: ev.agentId, toParent: false, color: agent.color, start: now },
      );
    }
    if (pulsesRef.current.length > MAX_PULSES) {
      pulsesRef.current.splice(0, pulsesRef.current.length - MAX_PULSES);
    }
  }, [props.liveEvents, props.agents]);

  const nodeAt = (x: number, y: number): GraphNode | null => {
    for (const node of nodesRef.current) {
      if (node.id === HUB_ID) continue;
      const dx = x - node.x;
      const dy = y - node.y;
      if (dx * dx + dy * dy <= (nodeRadius(node.depth) + 4) ** 2) return node;
    }
    return null;
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;
    const node = nodeAt(x, y);
    if (!node) {
      propsRef.current.onSelect(null);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id: node.id, moved: false, sx: x, sy: y };
    node.fx = node.x;
    node.fy = node.y;
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;
    const drag = dragRef.current;
    if (!drag) {
      e.currentTarget.style.cursor = nodeAt(x, y) ? 'pointer' : 'default';
      return;
    }
    const node = nodesRef.current.find((n) => n.id === drag.id);
    if (!node) return;
    if (!drag.moved && Math.hypot(x - drag.sx, y - drag.sy) > DRAG_THRESHOLD_PX) {
      drag.moved = true;
      e.currentTarget.style.cursor = 'grabbing';
      simRef.current?.alphaTarget(0.3).restart();
    }
    if (drag.moved) {
      node.fx = x;
      node.fy = y;
    }
  };

  const releaseDrag = (
    e: ReactPointerEvent<HTMLCanvasElement>,
  ): { id: string; moved: boolean } | null => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return null;
    e.currentTarget.style.cursor = 'default';
    simRef.current?.alphaTarget(0);
    return drag;
  };

  const restoreIfUnpinned = (id: string) => {
    const node = nodesRef.current.find((n) => n.id === id);
    const agent = propsRef.current.agents.find((a) => a.id === id);
    if (node && !agent?.pinned) {
      node.fx = null;
      node.fy = null;
    }
  };

  const handlePointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = releaseDrag(e);
    if (!drag) return;
    const node = nodesRef.current.find((n) => n.id === drag.id);
    if (!node) return;
    if (!drag.moved) {
      /* Clic simple : sélection (fx/fy relâchés si non épinglé). */
      restoreIfUnpinned(drag.id);
      propsRef.current.onSelect(drag.id);
      return;
    }
    /* Drop : épingle à la position courante, relative au centre du canvas. */
    const { w, h } = sizeRef.current;
    node.fx = node.x;
    node.fy = node.y;
    propsRef.current.onPin(drag.id, {
      x: Math.round(node.x - w / 2),
      y: Math.round(node.y - h / 2),
    });
  };

  const handlePointerCancel = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = releaseDrag(e);
    if (drag) restoreIfUnpinned(drag.id);
  };

  const handleDoubleClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const node = nodeAt(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    if (!node) return;
    node.fx = null;
    node.fy = null;
    simRef.current?.alpha(0.5).restart();
    propsRef.current.onPin(node.id, null);
  };

  return (
    <div ref={containerRef} className="canvas-host">
      <canvas
        ref={canvasRef}
        className="canvas-fill"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onDoubleClick={handleDoubleClick}
      />
    </div>
  );
}
