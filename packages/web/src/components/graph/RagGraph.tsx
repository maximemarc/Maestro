/**
 * Graphe d'une collection RAG (canvas 2D + d3-force), même langage visuel que
 * le graphe des agents.
 *
 * Trois niveaux de nœuds — collection, document, passage — reliés par la
 * structure, et des rapprochements lexicaux entre passages. C'est cette seconde
 * famille d'arêtes qui donne la toile : sans elle, on regarde un organigramme.
 *
 * Ce que la vue sert à voir, concrètement : les grappes de sujets, les
 * quasi-doublons, les passages qu'aucun autre ne rejoint, et — quand on lance
 * une recherche — où atterrissent les passages retrouvés.
 */
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
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
import type { RagGraph as RagGraphData, RagGraphNode } from '@maestro/shared';
import { canvasFont, canvasTokens } from '../../lib/theme';

const palette = canvasTokens;

const COLLECTION_R = 26;
const DOCUMENT_R = 13;
/** Rayon d'un passage, borné : la surface suit sa longueur, sans exagérer. */
const CHUNK_R_MIN = 4.5;
const CHUNK_R_MAX = 10;
const CHARS_FOR_MAX_R = 1600;

const COLLIDE_PAD = 5;
const DRAG_THRESHOLD_PX = 4;

/* La structure tient le squelette, les rapprochements ne doivent pas l'écraser :
   d'où un lien de similarité plus court et beaucoup plus faible. */
const LINK_COLLECTION = 190;
const LINK_DOCUMENT = 70;
const LINK_SIMILAR = 55;
const STRENGTH_CONTAINS = 0.6;
const STRENGTH_SIMILAR = 0.08;

/**
 * Répulsion entre nœuds.
 *
 * Réglée pour cent à deux cents nœuds : en dessous de cette valeur, le nuage se
 * tasse au centre et les passages se chevauchent, ce qui annule l'intérêt de la
 * vue.
 */
const CHARGE = -170;

/** Bornes du zoom. En dessous on ne distingue plus rien, au-delà on se perd. */
const ZOOM_MIN = 0.35;
const ZOOM_MAX = 3;
const ZOOM_STEP = 1.12;

/**
 * Échelle à partir de laquelle les étiquettes de documents apparaissent.
 *
 * Les afficher toutes d'emblée était le premier réflexe, et il rendait le graphe
 * illisible : trente et une étiquettes se chevauchaient au point de masquer les
 * nœuds. Comme dans un éditeur de notes, elles se révèlent quand on approche.
 */
const LABEL_ZOOM_DOCUMENT = 1.15;
const LABEL_ZOOM_CHUNK = 2;

interface GraphNode extends SimulationNodeDatum {
  id: string;
  kind: RagGraphNode['kind'];
  label: string;
  documentId: string | null;
  r: number;
  x: number;
  y: number;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  kind: 'contains' | 'similar';
  weight: number;
}

function chunkRadius(chars: number): number {
  const ratio = Math.min(1, chars / CHARS_FOR_MAX_R);
  return CHUNK_R_MIN + (CHUNK_R_MAX - CHUNK_R_MIN) * Math.sqrt(ratio);
}

function radiusOf(node: RagGraphNode): number {
  if (node.kind === 'collection') return COLLECTION_R;
  if (node.kind === 'document') return DOCUMENT_R;
  return chunkRadius(node.chars);
}

export interface RagGraphProps {
  graph: RagGraphData;
  selectedId: string | null;
  /** Passages remontés par la dernière recherche, mis en évidence. */
  highlightIds: ReadonlySet<string>;
  showSimilar: boolean;
  onSelect: (id: string | null) => void;
}

export default function RagGraph(props: RagGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<GraphNode[]>([]);
  const linksRef = useRef<GraphLink[]>([]);
  const simRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);
  const centerForceRef = useRef<ForceCenter<GraphNode> | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const hoverRef = useRef<string | null>(null);
  const dragRef = useRef<{ id: string; moved: boolean; sx: number; sy: number } | null>(null);
  /** Zoom et déplacement de la vue, en coordonnées écran. */
  const viewRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const panRef = useRef<{ sx: number; sy: number; tx: number; ty: number } | null>(null);
  const propsRef = useRef(props);

  useEffect(() => {
    propsRef.current = props;
  });

  /* --- Simulation : reconstruite quand la topologie change -------------- */
  useEffect(() => {
    const { graph } = props;
    const { w, h } = sizeRef.current;
    const cx = w / 2 || 400;
    const cy = h / 2 || 300;

    /* Les positions déjà calculées sont conservées d'un rendu au suivant : sans
       cela, un simple rafraîchissement rejetterait tout le graphe au centre. */
    const previous = new Map(nodesRef.current.map((n) => [n.id, n]));
    const nodes: GraphNode[] = graph.nodes.map((node) => {
      const old = previous.get(node.id);
      return {
        id: node.id,
        kind: node.kind,
        label: node.label,
        documentId: node.documentId,
        r: radiusOf(node),
        x: old?.x ?? cx + (Math.cos(hashAngle(node.id)) * (w || 800)) / 5,
        y: old?.y ?? cy + (Math.sin(hashAngle(node.id)) * (h || 600)) / 5,
        ...(old?.fx !== undefined ? { fx: old.fx, fy: old.fy } : {}),
      };
    });
    nodesRef.current = nodes;

    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: GraphLink[] = [];
    for (const link of graph.links) {
      const source = byId.get(link.source);
      const target = byId.get(link.target);
      if (!source || !target) continue;
      links.push({ source, target, kind: link.kind, weight: link.weight });
    }
    linksRef.current = links;

    /* La collection est ancrée au centre : elle sert de repère, et la laisser
       dériver rend la lecture du graphe instable d'un instant à l'autre. */
    const root = nodes.find((n) => n.kind === 'collection');
    if (root) {
      root.fx = cx;
      root.fy = cy;
    }

    simRef.current?.stop();
    const center = forceCenter<GraphNode>(cx, cy).strength(0.04);
    centerForceRef.current = center;
    simRef.current = forceSimulation<GraphNode, GraphLink>(nodes)
      .force('charge', forceManyBody<GraphNode>().strength(CHARGE).distanceMax(520))
      .force(
        'collide',
        forceCollide<GraphNode>((n) => n.r + COLLIDE_PAD),
      )
      .force('center', center)
      .force(
        'link',
        forceLink<GraphNode, GraphLink>(links)
          .id((n) => n.id)
          .distance((l) =>
            l.kind === 'similar'
              ? LINK_SIMILAR
              : (l.source as GraphNode).kind === 'collection'
                ? LINK_COLLECTION
                : LINK_DOCUMENT,
          )
          .strength((l) =>
            l.kind === 'similar' ? STRENGTH_SIMILAR * l.weight : STRENGTH_CONTAINS,
          ),
      )
      .alpha(0.9)
      .restart();

    return () => {
      simRef.current?.stop();
    };
    // La topologie ne dépend que du graphe reçu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.graph]);

  /* --- Canvas : taille, boucle de rendu -------------------------------- */
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
      const root = nodesRef.current.find((n) => n.kind === 'collection');
      if (root) {
        root.fx = cx;
        root.fy = cy;
      }
      simRef.current?.alpha(0.3).restart();
    };

    syncSize();
    const observer = new ResizeObserver(syncSize);
    observer.observe(container);

    /* Le CSS ne peut rien pour un canvas : on interroge la même préférence. */
    const calmMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { w, h } = sizeRef.current;
      if (w === 0 || h === 0) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      /* Le zoom et le déplacement s'appliquent après l'effacement : la
         simulation, elle, continue de travailler en coordonnées de graphe. */
      const view = viewRef.current;
      ctx.translate(view.tx, view.ty);
      ctx.scale(view.scale, view.scale);

      const colors = palette();
      const { selectedId, highlightIds, showSimilar } = propsRef.current;
      const nodes = nodesRef.current;
      const hovered = hoverRef.current;

      /* --- Arêtes ------------------------------------------------------ */
      for (const link of linksRef.current) {
        const a = link.source as GraphNode;
        const b = link.target as GraphNode;
        if (link.kind === 'similar') {
          if (!showSimilar) continue;
          ctx.strokeStyle = colors.accent;
          /* L'opacité porte le poids du rapprochement : un trait uniforme
             donnerait le même crédit à une parenté forte et à une faible. */
          ctx.globalAlpha = 0.1 + 0.35 * link.weight;
          ctx.lineWidth = 0.6 + 1.2 * link.weight;
        } else {
          ctx.strokeStyle = colors.border;
          ctx.globalAlpha = 1;
          ctx.lineWidth = a.kind === 'collection' ? 1.4 : 1;
        }
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      /* --- Nœuds ------------------------------------------------------- */
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      for (const node of nodes) {
        const isSelected = node.id === selectedId;
        const isHovered = node.id === hovered;
        const isHit = highlightIds.has(node.id);

        ctx.beginPath();
        ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
        ctx.fillStyle =
          node.kind === 'collection'
            ? colors.bgElevated
            : node.kind === 'document'
              ? colors.bgElevated
              : isHit
                ? colors.ok
                : colors.bgHover;
        ctx.fill();

        ctx.lineWidth = isSelected ? 2.5 : isHit ? 2 : 1.2;
        ctx.strokeStyle = isSelected
          ? colors.text
          : isHit
            ? colors.ok
            : node.kind === 'collection'
              ? colors.accent
              : node.kind === 'document'
                ? colors.textMuted
                : colors.borderStrong;
        ctx.stroke();

        /* --- Étiquettes -------------------------------------------------
           La collection et les documents sont toujours nommés : ce sont les
           repères. Un passage ne l'est qu'au survol ou à la sélection, sinon
           quatre-vingt-dix étiquettes se chevauchent et cachent le graphe. */
        const zoom = view.scale;
        const showLabel =
          node.kind === 'collection' ||
          isSelected ||
          isHovered ||
          (isHit && highlightIds.size <= 10) ||
          (node.kind === 'document' && zoom >= LABEL_ZOOM_DOCUMENT) ||
          (node.kind === 'chunk' && zoom >= LABEL_ZOOM_CHUNK);
        if (!showLabel) continue;

        /* La taille du texte compense le zoom : une étiquette doit rester
           lisible sans devenir énorme quand on approche. */
        const fontPx = (node.kind === 'collection' ? 12 : 10.5) / Math.max(1, zoom * 0.75);
        ctx.font = canvasFont(fontPx);
        ctx.fillStyle =
          node.kind === 'collection'
            ? colors.text
            : isSelected || isHovered
              ? colors.text
              : colors.textMuted;
        const label = node.kind === 'chunk' ? node.label : shorten(node.label, 34);
        ctx.fillText(label, node.x, node.y + node.r + fontPx * 0.9);
      }

      if (calmMotion) simRef.current?.stop();
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  /* --- Interaction ------------------------------------------------------ */

  /**
   * Convertit un point de l'écran en point du graphe.
   *
   * Sans cette inversion, viser un nœud devient impossible dès le premier zoom :
   * le dessin est transformé, la détection ne l'était pas.
   */
  const toGraph = (x: number, y: number): { gx: number; gy: number } => {
    const { scale, tx, ty } = viewRef.current;
    return { gx: (x - tx) / scale, gy: (y - ty) / scale };
  };

  const nodeAt = (x: number, y: number): GraphNode | null => {
    const { gx, gy } = toGraph(x, y);
    const tolerance = 3 / viewRef.current.scale;
    /* Parcours inverse : les passages sont dessinés après, donc au-dessus. */
    const nodes = nodesRef.current;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i]!;
      if (Math.hypot(gx - node.x, gy - node.y) <= node.r + tolerance) return node;
    }
    return null;
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;
    const node = nodeAt(x, y);
    if (!node) {
      /* Fond vide : on déplace la vue au lieu de ne rien faire. C'est le geste
         attendu sur un graphe qu'on peut zoomer. */
      const view = viewRef.current;
      panRef.current = { sx: x, sy: y, tx: view.tx, ty: view.ty };
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.style.cursor = 'grabbing';
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
    const pan = panRef.current;
    if (pan) {
      viewRef.current.tx = pan.tx + (x - pan.sx);
      viewRef.current.ty = pan.ty + (y - pan.sy);
      return;
    }
    const drag = dragRef.current;
    if (!drag) {
      const under = nodeAt(x, y);
      hoverRef.current = under?.id ?? null;
      e.currentTarget.style.cursor = under ? 'pointer' : 'grab';
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
      const { gx, gy } = toGraph(x, y);
      node.fx = gx;
      node.fy = gy;
    }
  };

  const handlePointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (panRef.current) {
      panRef.current = null;
      e.currentTarget.style.cursor = 'grab';
      return;
    }
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    e.currentTarget.style.cursor = 'default';
    simRef.current?.alphaTarget(0);
    /* Un clic sans déplacement sélectionne ; un déplacement épingle le nœud là
       où on l'a lâché, et le double-clic le libère. */
    if (!drag.moved) {
      const node = nodesRef.current.find((n) => n.id === drag.id);
      if (node && node.kind !== 'collection') {
        node.fx = undefined;
        node.fy = undefined;
      }
      propsRef.current.onSelect(drag.id);
    }
  };

  /**
   * Zoom à la molette, centré sur le pointeur.
   *
   * L'écouteur est posé à la main et non par la propriété `onWheel` : React
   * enregistre les écouteurs de molette en mode passif, où `preventDefault` est
   * ignoré. Le graphe zoomait donc correctement, mais la page défilait en même
   * temps et le graphe sortait de l'écran.
   *
   * Le point visé reste fixe pendant le zoom, comme sur n'importe quelle carte :
   * zoomer sur le centre du canevas obligerait à recadrer après chaque cran.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const view = viewRef.current;
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.scale * factor));
      if (next === view.scale) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      view.tx = x - ((x - view.tx) * next) / view.scale;
      view.ty = y - ((y - view.ty) * next) / view.scale;
      view.scale = next;
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  /** Remet la vue à plat, sans toucher aux positions calculées. */
  const resetView = () => {
    viewRef.current = { scale: 1, tx: 0, ty: 0 };
  };

  const handleDoubleClick = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const node = nodeAt(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    /* Double-clic sur le fond : la vue revient à son cadrage d'origine. */
    if (!node) {
      resetView();
      return;
    }
    if (node.kind === 'collection') return;
    node.fx = undefined;
    node.fy = undefined;
    simRef.current?.alpha(0.3).restart();
  };

  return (
    <div ref={containerRef} className="canvas-host">
      <canvas
        ref={canvasRef}
        className="canvas-fill"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        /* Le canvas n'est pas atteignable au clavier : la liste des documents,
           juste à côté, donne le même accès au contenu. */
        aria-label={`Graphe de ${props.graph.nodes.length} nœuds et ${props.graph.links.length} liens. Le tableau des documents donne le même contenu.`}
        role="img"
      />
    </div>
  );
}

/** Angle stable dérivé d'un identifiant : place les nœuds sans hasard. */
function hashAngle(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return ((hash % 360) * Math.PI) / 180;
}

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
