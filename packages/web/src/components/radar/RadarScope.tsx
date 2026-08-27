/**
 * Scope radar (canvas 2D maison) : une session détectée = un blip.
 *
 * L'angle et le rayon d'un blip viennent d'un hash **stable** de l'identifiant
 * de session : sans ça, les points sauteraient d'un balayage à l'autre et le
 * scope serait illisible. Le rayon dit la fraîcheur (centre = actif), l'anneau
 * supplémentaire dit « pilotée par Maestro » — l'information la plus utile ici.
 */
import {
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { AgentToolKind, DetectedSession, SessionFreshness } from '@maestro/shared';
import { canvasFont, canvasTokens } from '../../lib/theme';

const TAU = Math.PI * 2;
/** Un tour de balayage complet. */
const SWEEP_MS = 4000;
/** Durée du halo laissé derrière le passage du balayage sur un blip. */
const PING_MS = 900;
/** Marge autour du scope : réserve la place des étiquettes de projet. */
const SCOPE_PAD = 34;
const RING_COUNT = 4;
const BLIP_R = 4;
const BLIP_R_HOVER = 6.5;
const LABEL_MAX_CHARS = 14;
/** Tolérance de survol/clic : un blip de 4 px serait impossible à viser. */
const HIT_PAD = 9;
/** Traînée : ouverture angulaire et nombre de secteurs qui la composent. */
const TRAIL_ARC = Math.PI * 0.55;
const TRAIL_STEPS = 26;

/**
 * Couleurs et polices : lues depuis la feuille de style (voir lib/theme).
 *
 * Les valeurs étaient recopiées ici en hexadécimal. Une recalibration de la
 * palette laissait donc le radar en retard sur le reste de l'interface, sans
 * avertissement.
 */
const palette = canvasTokens;

/** Une teinte par outil, pour séparer les familles de sessions d'un coup d'œil. */
export const TOOL_COLORS: Record<AgentToolKind, string> = {
  'claude-code': '#22d3ee', // cyan
  codex: '#a78bfa', // violet
  gemini: '#60a5fa', // bleu
  aider: '#34d399', // vert
  cursor: '#fbbf24', // ambre
  opencode: '#f472b6', // rose
  goose: '#fb923c', // orange
  other: '#9aa7bd', // gris, aligné sur --text-muted
};

/** Distance au centre (fraction du rayon) : plus c'est frais, plus c'est proche. */
const FRESHNESS_RADIUS: Record<SessionFreshness, number> = {
  active: 0.3,
  idle: 0.6,
  stale: 0.88,
};
/** Amplitude du décalage déterministe qui évite les blips exactement superposés. */
const RADIUS_SPREAD = 0.11;

export interface RadarScopeProps {
  sessions: DetectedSession[];
  selectedId: string | null;
  /** Reçoit null quand le clic tombe à côté d'un blip (désélection). */
  onSelect: (id: string | null) => void;
}

/** Position réellement dessinée d'un blip : sert au survol et au clic. */
interface Blip {
  id: string;
  x: number;
  y: number;
  r: number;
}

/** FNV-1a 32 bits : court, sans dépendance, et stable entre deux balayages. */
function hash32(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Angle (rad) et facteur de rayon d'une session, entièrement dérivés de son id. */
function blipPolar(session: DetectedSession): { angle: number; radiusFactor: number } {
  const h = hash32(session.id);
  const angle = ((h % 10_000) / 10_000) * TAU;
  /* Deuxième valeur tirée des bits hauts : décorrélée de l'angle. */
  const jitter = (((h >>> 13) % 1000) / 1000 - 0.5) * RADIUS_SPREAD;
  const base = FRESHNESS_RADIUS[session.freshness];
  return { angle, radiusFactor: Math.min(0.95, Math.max(0.14, base + jitter)) };
}

/**
 * Étiquette du blip. Pour une session pilotée, `project` est le nom technique du
 * répertoire de workspace : le nom de l'agent est bien plus parlant.
 */
function blipLabel(session: DetectedSession): string {
  const raw = session.managed?.agentName ?? session.project ?? session.toolLabel;
  return raw.length > LABEL_MAX_CHARS ? `${raw.slice(0, LABEL_MAX_CHARS - 1)}…` : raw;
}

export default function RadarScope(props: RadarScopeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  const sizeRef = useRef({ w: 0, h: 0 });
  const blipsRef = useRef<Blip[]>([]);
  const hoverIdRef = useRef<string | null>(null);

  /* Doit rester le premier effet : la boucle de rendu lit propsRef. */
  useEffect(() => {
    propsRef.current = props;
  });

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
    };

    syncSize();
    const observer = new ResizeObserver(syncSize);
    observer.observe(container);

    /* Le CSS ne peut rien pour un canvas : on interroge la même préférence.
       Balayage figé en haut du scope, et donc aucun ping. */
    const calmMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let raf = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const { w, h } = sizeRef.current;
      if (w === 0 || h === 0) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      /* Le rayon suit le plus petit côté : le scope reste circulaire. */
      const radius = Math.max(20, Math.min(w, h) / 2 - SCOPE_PAD);
      const { sessions, selectedId } = propsRef.current;
      const hoverId = hoverIdRef.current;

      /* --- Grille : cercles concentriques + axes en croix ------------------ */
      ctx.lineWidth = 1;
      for (let i = 1; i <= RING_COUNT; i++) {
        ctx.beginPath();
        ctx.arc(cx, cy, (radius * i) / RING_COUNT, 0, TAU);
        ctx.strokeStyle = i === RING_COUNT ? palette().borderStrong : palette().bgHover;
        ctx.stroke();
      }
      ctx.strokeStyle = palette().bgHover;
      ctx.beginPath();
      ctx.moveTo(cx - radius, cy);
      ctx.lineTo(cx + radius, cy);
      ctx.moveTo(cx, cy - radius);
      ctx.lineTo(cx, cy + radius);
      ctx.stroke();

      /* --- Balayage : traînée en secteurs dégressifs, puis ligne de tête ---- */
      const sweep = calmMotion ? -Math.PI / 2 : ((now % SWEEP_MS) / SWEEP_MS) * TAU;
      for (let i = 0; i < TRAIL_STEPS; i++) {
        const t0 = i / TRAIL_STEPS;
        const t1 = (i + 1) / TRAIL_STEPS;
        const alpha = 0.1 * (1 - t0) ** 1.8;
        ctx.fillStyle = `rgba(${palette().accentRgb}, ${alpha.toFixed(4)})`;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        /* Secteurs légèrement débordants : sinon l'antialiasing laisse des rayures. */
        ctx.arc(cx, cy, radius, sweep - TRAIL_ARC * t1, sweep - TRAIL_ARC * t0 + 0.006);
        ctx.closePath();
        ctx.fill();
      }
      const headX = cx + Math.cos(sweep) * radius;
      const headY = cy + Math.sin(sweep) * radius;
      const headGrad = ctx.createLinearGradient(cx, cy, headX, headY);
      headGrad.addColorStop(0, `rgba(${palette().accentRgb}, 0.06)`);
      headGrad.addColorStop(1, `rgba(${palette().accentRgb}, 0.5)`);
      ctx.strokeStyle = headGrad;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(headX, headY);
      ctx.stroke();

      /* Centre du scope. */
      ctx.beginPath();
      ctx.arc(cx, cy, 2, 0, TAU);
      ctx.fillStyle = palette().textFaint;
      ctx.fill();

      /* --- Blips ---------------------------------------------------------- */
      const blips: Blip[] = [];
      ctx.textBaseline = 'middle';
      for (const session of sessions) {
        const { angle, radiusFactor } = blipPolar(session);
        const x = cx + Math.cos(angle) * radius * radiusFactor;
        const y = cy + Math.sin(angle) * radius * radiusFactor;
        const isHover = hoverId === session.id;
        const isSelected = selectedId === session.id;
        const r = isHover ? BLIP_R_HOVER : isSelected ? BLIP_R + 1.5 : BLIP_R;
        const color = TOOL_COLORS[session.tool];
        blips.push({ id: session.id, x, y, r });

        /* Ping : temps écoulé depuis le dernier passage du balayage sur cet angle.
           Se déduit de l'écart angulaire, donc aucun état à conserver. */
        const delta = (((sweep - angle) % TAU) + TAU) % TAU;
        const sincePass = (delta / TAU) * SWEEP_MS;
        const ping = !calmMotion && sincePass < PING_MS ? 1 - sincePass / PING_MS : 0;
        if (ping > 0) {
          ctx.beginPath();
          ctx.arc(x, y, r + 3 + 9 * (1 - ping), 0, TAU);
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.4 * ping;
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fillStyle = color;
        ctx.fill();

        /* Anneau des sessions pilotées par Maestro : c'est ce qui les sépare
           d'une session lancée à la main dans un terminal. */
        if (session.managed) {
          ctx.beginPath();
          ctx.arc(x, y, r + 4, 0, TAU);
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.75;
          ctx.lineWidth = 1.2;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

        if (isSelected) {
          ctx.beginPath();
          ctx.arc(x, y, r + 8, 0, TAU);
          ctx.strokeStyle = palette().text;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        /* Étiquette rabattue vers l'intérieur du scope pour rester lisible. */
        const toLeft = x > cx;
        ctx.font = canvasFont(11);
        ctx.textAlign = toLeft ? 'right' : 'left';
        ctx.fillStyle = isSelected || isHover ? palette().text : palette().textMuted;
        ctx.fillText(blipLabel(session), x + (toLeft ? -(r + 6) : r + 6), y);
      }
      blipsRef.current = blips;

      if (sessions.length === 0) {
        ctx.font = canvasFont(12);
        ctx.textAlign = 'center';
        ctx.fillStyle = palette().textMuted;
        ctx.fillText('aucune session détectée', cx, cy + 18);
      }
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      blipsRef.current = [];
    };
  }, []);

  /** Blip sous le curseur, en visant le plus proche du point cliqué. */
  const blipAt = (x: number, y: number): Blip | null => {
    let best: Blip | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const blip of blipsRef.current) {
      const dist = Math.hypot(x - blip.x, y - blip.y);
      if (dist <= blip.r + HIT_PAD && dist < bestDist) {
        best = blip;
        bestDist = dist;
      }
    }
    return best;
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const blip = blipAt(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    hoverIdRef.current = blip ? blip.id : null;
    e.currentTarget.style.cursor = blip ? 'pointer' : 'default';
  };

  const handlePointerLeave = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    hoverIdRef.current = null;
    e.currentTarget.style.cursor = 'default';
  };

  const handleClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const blip = blipAt(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    propsRef.current.onSelect(blip ? blip.id : null);
  };

  return (
    <div ref={containerRef} className="canvas-host">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Scope radar : ${props.sessions.length} session(s) détectée(s). Le tableau ci-dessous liste les mêmes sessions.`}
        className="canvas-fill"
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onClick={handleClick}
      />
    </div>
  );
}
