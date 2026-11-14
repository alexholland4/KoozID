// Small single-series charts for the stats page, drawn as plain SVG (no chart library).
// One hue (the accent), 2px lines, columns capped at 24px with 4px rounded tops, hairline grid.
// Each chart has a readout line above it: it shows the latest value and follows the pointer or
// a tap, so values are reachable on touch screens without tooltips covering the marks.

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { fmtNum } from "./ui";

const H = 180;
const PAD = { top: 12, right: 12, bottom: 24, left: 36 };

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** A round axis maximum and its ticks (1/2/5 steps, about four ticks). */
function niceScale(max: number) {
  if (max <= 0) return { top: 1, ticks: [0, 1] };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(t);
  return { top, ticks };
}

const compact = (n: number) => (n >= 1000 ? `${+(n / 1000).toFixed(1)}K` : String(n));
const dayMs = (d: string) => Date.parse(`${d}T12:00:00Z`);
const monthLabel = (ym: string, year = true) =>
  new Date(`${ym}-15T12:00:00Z`).toLocaleDateString(undefined, { month: "short", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function Grid({ w, ticks, y }: { w: number; ticks: number[]; y: (v: number) => number }) {
  return (
    <g className="chart-grid">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.left} x2={w - PAD.right} y1={y(t)} y2={y(t)} />
          <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
            {compact(t)}
          </text>
        </g>
      ))}
    </g>
  );
}

/** Running total over time, from per-day counts. */
export function GrowthChart({ days }: { days: { day: string; count: number }[] }) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  let sum = 0;
  const pts = days.map((d) => ({ day: d.day, added: d.count, total: (sum += d.count), t: dayMs(d.day) }));
  const last = pts.length - 1;
  const shown = pts[hover ?? last];

  let plot = null;
  if (w > 0 && pts.length > 0) {
    const t0 = pts[0].t;
    const t1 = Math.max(pts[last].t, t0 + 86_400_000);
    const { top, ticks } = niceScale(pts[last].total);
    const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0)) * (w - PAD.left - PAD.right);
    const y = (v: number) => PAD.top + (1 - v / top) * (H - PAD.top - PAD.bottom);
    // Start from zero the day before the first koozie, so the first jump is visible.
    const line = [`M${x(t0)},${y(0)}`, ...pts.map((p) => `L${x(p.t)},${y(p.total)}`)].join(" ");
    const area = `${line} L${x(pts[last].t)},${y(0)} Z`;
    // About four month ticks, on the first of the month.
    const months: string[] = [];
    const start = new Date(t0);
    for (let m = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)); m.getTime() <= t1; m.setUTCMonth(m.getUTCMonth() + 1)) {
      months.push(m.toISOString().slice(0, 7));
    }
    const every = Math.max(1, Math.ceil(months.length / 4));
    const onMove = (e: PointerEvent<SVGSVGElement>) => {
      const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
      let best = 0;
      for (let i = 1; i < pts.length; i++) if (Math.abs(x(pts[i].t) - px) < Math.abs(x(pts[best].t) - px)) best = i;
      setHover(best);
    };
    const hp = pts[hover ?? last];
    plot = (
      <svg width={w} height={H} onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="Collection growth over time">
        <Grid w={w} ticks={ticks} y={y} />
        <g className="chart-axis">
          {months
            .filter((_, i) => i % every === 0)
            .map((m) => (
              <text key={m} x={x(dayMs(`${m}-01`))} y={H - 6} textAnchor="middle">
                {monthLabel(m)}
              </text>
            ))}
        </g>
        <path d={area} className="chart-area" />
        <path d={line} className="chart-line" />
        {hover !== null && <line className="chart-cross" x1={x(hp.t)} x2={x(hp.t)} y1={PAD.top} y2={H - PAD.bottom} />}
        <circle className="chart-dot" cx={x(hp.t)} cy={y(hp.total)} r={4} />
      </svg>
    );
  }

  return (
    <div className="chart">
      <div className="chart-readout" aria-live="polite">
        {shown ? (
          <>
            <span className="mono">{fmtNum(shown.total)}</span> koozies by {dayLabel(shown.day)}
            <span className="muted"> · +{fmtNum(shown.added)} that day</span>
          </>
        ) : (
          <span className="muted">No koozies yet</span>
        )}
      </div>
      <div ref={ref} className="chart-plot">
        {plot}
      </div>
    </div>
  );
}

/** Koozies added per calendar month, the most recent `months` months. */
export function MonthlyChart({ days, months = 12 }: { days: { day: string; count: number }[]; months?: number }) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const byMonth = new Map<string, number>();
  for (const d of days) byMonth.set(d.day.slice(0, 7), (byMonth.get(d.day.slice(0, 7)) ?? 0) + d.count);
  // Every month from the first koozie (or `months` ago) through this month, including empty ones.
  const now = new Date();
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const first = days.length ? dayMs(days[0].day) : end;
  const startDate = new Date(Math.max(first, Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months + 1, 1)));
  const rows: { m: string; n: number }[] = [];
  for (let m = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1)); m.getTime() <= end; m.setUTCMonth(m.getUTCMonth() + 1)) {
    const key = m.toISOString().slice(0, 7);
    rows.push({ m: key, n: byMonth.get(key) ?? 0 });
  }
  const shown = rows[hover ?? rows.length - 1];

  let plot = null;
  if (w > 0 && rows.length) {
    const { top, ticks } = niceScale(Math.max(...rows.map((r) => r.n)));
    const y = (v: number) => PAD.top + (1 - v / top) * (H - PAD.top - PAD.bottom);
    const band = (w - PAD.left - PAD.right) / rows.length;
    const bw = Math.min(24, band - 2);
    const peak = rows.reduce((b, r, i) => (r.n > rows[b].n ? i : b), 0);
    const every = Math.max(1, Math.ceil(rows.length / 6));
    plot = (
      <svg width={w} height={H} onPointerLeave={() => setHover(null)} role="img" aria-label="Koozies added per month">
        <Grid w={w} ticks={ticks} y={y} />
        {rows.map((r, i) => {
          const cx = PAD.left + band * (i + 0.5);
          const h = y(0) - y(r.n);
          const rr = Math.min(4, h, bw / 2);
          const x0 = cx - bw / 2;
          const d = `M${x0},${y(0)} V${y(r.n) + rr} Q${x0},${y(r.n)} ${x0 + rr},${y(r.n)} H${x0 + bw - rr} Q${x0 + bw},${y(r.n)} ${x0 + bw},${y(r.n) + rr} V${y(0)} Z`;
          return (
            <g key={r.m}>
              {r.n > 0 && <path d={d} className={`chart-col${hover === i ? " on" : ""}`} />}
              {i === peak && r.n > 0 && (
                <text className="chart-value" x={cx} y={y(r.n) - 6} textAnchor="middle">
                  {r.n}
                </text>
              )}
              {i % every === 0 && (
                <text className="chart-axis-text" x={cx} y={H - 6} textAnchor="middle">
                  {monthLabel(r.m, false)}
                </text>
              )}
              {/* Hit target: the whole band, taller than the mark. */}
              <rect x={cx - band / 2} y={PAD.top} width={band} height={H - PAD.top} fill="transparent" onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)} />
            </g>
          );
        })}
      </svg>
    );
  }

  return (
    <div className="chart">
      <div className="chart-readout" aria-live="polite">
        {shown && (
          <>
            <span className="mono">{fmtNum(shown.n)}</span> added in {monthLabel(shown.m)}
          </>
        )}
      </div>
      <div ref={ref} className="chart-plot">
        {plot}
      </div>
    </div>
  );
}

/** Ranked horizontal bars with the value at each bar's tip. */
export function BarList({
  rows,
  onPick,
  stacked = false,
}: {
  rows: { name: string; count: number; rank?: number }[];
  onPick?: (name: string) => void;
  stacked?: boolean;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className={`barlist${stacked ? " stacked" : ""}`}>
      {rows.map((r) => {
        const body = (
          <>
            <span className={`name ${stacked ? "clamp-2" : "clamp-1"}`}>
              {r.rank !== undefined && <span className="rank mono">{r.rank}</span>}
              {r.name}
            </span>
            <span className="track">
              <span className="bar" style={{ width: `${(100 * r.count) / max}%` }} />
              <span className="mono small">{fmtNum(r.count)}</span>
            </span>
          </>
        );
        return onPick ? (
          <button key={r.name} className="barrow" onClick={() => onPick(r.name)}>
            {body}
          </button>
        ) : (
          <div key={r.name} className="barrow">
            {body}
          </div>
        );
      })}
    </div>
  );
}
