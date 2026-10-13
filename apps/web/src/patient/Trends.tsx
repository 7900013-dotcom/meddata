import { fmtDate, type Series } from "../api";
import { useLoad } from "../hooks";

export function Chart({ s }: { s: Series }) {
  const pts = s.points.filter((p) => p.value != null) as (Series["points"][number] & { value: number })[];
  if (pts.length === 0) return <p className="small muted">No numeric values.</p>;
  const W = 560, H = 180, P = 32;
  const lo = s.points.find((p) => p.ref_low != null)?.ref_low ?? null;
  const hi = s.points.find((p) => p.ref_high != null)?.ref_high ?? null;
  const vals = [...pts.map((p) => p.value), ...(lo != null ? [lo] : []), ...(hi != null ? [hi] : [])];
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const y = (v: number) => H - P - ((v - min) / span) * (H - 2 * P);
  const x = (i: number) => (pts.length === 1 ? W / 2 : P + (i / (pts.length - 1)) * (W - 2 * P));
  const out = (p: { value: number; ref_low: number | null; ref_high: number | null }) => (p.ref_low != null && p.value < p.ref_low) || (p.ref_high != null && p.value > p.ref_high);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${s.test} over time`}>
      {lo != null && hi != null && <rect className="band" x={P} width={W - 2 * P} y={y(hi)} height={Math.max(1, y(lo) - y(hi))} />}
      <polyline className="line" points={pts.map((p, i) => `${x(i)},${y(p.value)}`).join(" ")} />
      {pts.map((p, i) => (
        <g key={i}>
          <circle className={`pt ${out(p) ? "out" : ""}`} cx={x(i)} cy={y(p.value)} r={4}>
            <title>{`${fmtDate(p.date)}: ${p.value_text} ${s.unit ?? ""}`}</title>
          </circle>
          <text x={x(i)} y={H - 8} textAnchor="middle">{new Date(`${p.date}T00:00:00`).toLocaleDateString(undefined, { month: "short", year: "2-digit" })}</text>
          <text x={x(i)} y={y(p.value) - 8} textAnchor="middle">{p.value_text}</text>
        </g>
      ))}
    </svg>
  );
}

export function TrendList({ series }: { series: Series[] }) {
  return (
    <div className="stack">
      {series.map((s) => {
        const last = s.points[s.points.length - 1];
        return (
          <section key={s.test} className="panel stack" style={{ gap: 8 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3>{s.test}</h3>
              <span className="small muted">
                Latest {last.value_text} {s.unit ?? ""} · {fmtDate(last.date)}
              </span>
            </div>
            <Chart s={s} />
          </section>
        );
      })}
    </div>
  );
}

export function Trends() {
  const { data, error } = useLoad<Series[]>("/api/trends");
  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Trends</h1>
          <p className="sub">Each lab value over time. The shaded band is the lab's reference range; red points are outside it.</p>
        </div>
      </div>
      {error && <p className="alert error">{error}</p>}
      {data && data.length === 0 && <p className="panel muted">Trends appear once you have confirmed lab results.</p>}
      {data && <TrendList series={data} />}
    </>
  );
}
