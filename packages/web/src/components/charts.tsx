/**
 * Composants de graphique SVG réutilisables — aucune dépendance externe.
 * Barres empilées, axes recessifs, <title> natif pour le survol.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';

export interface ChartSeries {
  name: string;
  color: string;
}

export interface ChartDatum {
  /** Étiquette de l'axe X (ex. « 25/08 »). */
  xLabel: string;
  /** Contenu du <title> natif affiché au survol de la barre. */
  title: string;
  /** Une valeur par série, dans l'ordre de `series`. */
  values: number[];
}

/** Mesure la largeur du conteneur (ResizeObserver) pour un SVG net à 100 %. */
function useMeasuredWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Échelle Y « propre » : 3-4 ticks sur des pas ronds (1 / 2 / 2.5 / 5 × 10^n). */
function buildScale(max: number): { yMax: number; ticks: number[] } {
  if (max <= 0) return { yMax: 1, ticks: [] };
  const rough = max / 3;
  const pow = 10 ** Math.floor(Math.log10(rough));
  let step = 10 * pow;
  for (const c of [1, 2, 2.5, 5, 10]) {
    if (c * pow >= rough) {
      step = c * pow;
      break;
    }
  }
  const yMax = step * Math.ceil(max / step - 1e-9);
  const ticks: number[] = [];
  for (let v = step; v <= yMax + step / 2; v += step) ticks.push(v);
  return { yMax, ticks };
}

const MARGIN = { top: 8, right: 8, bottom: 22, left: 52 } as const;
/** Espace entre barres et entre segments empilés (règle dataviz : 2px). */
const BAR_GAP = 2;

export function StackedBarChart(props: {
  data: ChartDatum[];
  series: ChartSeries[];
  formatTick: (v: number) => string;
  height?: number;
}) {
  const [ref, width] = useMeasuredWidth();
  const height = props.height ?? 220;
  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const n = props.data.length;

  const max = props.data.reduce((m, d) => {
    const sum = d.values.reduce((a, b) => a + b, 0);
    return sum > m ? sum : m;
  }, 0);
  const { yMax, ticks } = buildScale(max);
  const y = (v: number) => MARGIN.top + plotH * (1 - v / yMax);

  // Une étiquette X sur N si dense (~44px mini par étiquette).
  const maxLabels = Math.max(1, Math.floor(plotW / 44));
  const labelEvery = Math.max(1, Math.ceil(n / maxLabels));

  const slot = n > 0 ? plotW / n : 0;
  const barW = Math.max(1, slot - BAR_GAP);

  return (
    <div ref={ref} className="chart-host">
      {width > 0 && (
        <svg width={width} height={height} role="img" className="chart-svg">
          {/* Gridlines + ticks Y */}
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={y(t)}
                y2={y(t)}
                stroke="var(--border)"
                strokeWidth={1}
              />
              <text
                x={MARGIN.left - 6}
                y={y(t)}
                textAnchor="end"
                dominantBaseline="central"
                fontSize={11}
                fill="var(--text-muted)"
              >
                {props.formatTick(t)}
              </text>
            </g>
          ))}
          {/* Ligne de base */}
          <line
            x1={MARGIN.left}
            x2={width - MARGIN.right}
            y1={y(0)}
            y2={y(0)}
            stroke="var(--border)"
            strokeWidth={1}
          />

          {/* Barres empilées */}
          {props.data.map((d, i) => {
            const x = MARGIN.left + i * slot + (slot - barW) / 2;
            let cursor = 0;
            const segs = props.series.map((s, si) => {
              const v = d.values[si] ?? 0;
              if (v <= 0) return null;
              const y1 = y(cursor + v);
              const y0 = y(cursor);
              cursor += v;
              // 2px d'espace entre segments empilés, jamais de barre fantôme.
              const h = Math.max(1, y0 - y1 - (cursor - v > 0 ? BAR_GAP : 0));
              return <rect key={s.name} x={x} y={y1} width={barW} height={h} fill={s.color} />;
            });
            return (
              <g key={d.xLabel + i}>
                <title>{d.title}</title>
                {/* Zone de survol pleine hauteur (cible plus large que la barre). */}
                <rect
                  x={MARGIN.left + i * slot}
                  y={MARGIN.top}
                  width={Math.max(1, slot)}
                  height={plotH}
                  fill="transparent"
                />
                {segs}
                {i % labelEvery === 0 && (
                  <text
                    x={x + barW / 2}
                    y={height - 6}
                    textAnchor="middle"
                    fontSize={11}
                    fill="var(--text-muted)"
                  >
                    {d.xLabel}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {props.series.length > 1 && <ChartLegend items={props.series} />}
    </div>
  );
}

export function ChartLegend({ items }: { items: ChartSeries[] }) {
  return (
    <div className="row gap-4 wrap mt-3">
      {items.map((it) => (
        <span key={it.name} className="row gap-2 text-sm text-muted">
          <span className="legend-swatch" style={{ background: it.color }} />
          {it.name}
        </span>
      ))}
    </div>
  );
}
