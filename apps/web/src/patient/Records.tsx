import { Link } from "react-router-dom";
import { fmtDate, KIND_LABEL, type RecordRow } from "../api";
import { useLoad } from "../hooks";
import { DEMO } from "../demo";

export function RecordList({ records, pdfBase }: { records: RecordRow[]; pdfBase: string }) {
  const byDate = new Map<string, RecordRow[]>();
  for (const r of records) byDate.set(r.investigation_date, [...(byDate.get(r.investigation_date) ?? []), r]);
  return (
    <>
      {[...byDate].map(([date, rows]) => (
        <section key={date}>
          <div className="datehead">
            <h3>{fmtDate(date)}</h3>
            <a className="btn sm" href={`${pdfBase}/${date}/pdf`} onClick={DEMO ? (e) => (e.preventDefault(), import("../demo/pdf").then((m) => m.downloadDatePdf(pdfBase, date))) : undefined}>Download PDF</a>
          </div>
          <div className="list">
            {rows.map((r) => (
              <article className="item" key={r.id}>
                <div className="stack" style={{ gap: 4 }}>
                  <div className="row">
                    <span className="chip">{KIND_LABEL[r.kind] ?? r.kind}</span>
                    {r.source === "email" && <span className="chip low">From lab email</span>}
                  </div>
                  <strong>{r.title}</strong>
                  <span className="small muted">{[r.institution, r.doctor_name].filter(Boolean).join(" · ")}</span>
                  {r.summary && <p className="small">{r.summary}</p>}
                  {!!r.data.medicines?.length && (
                    <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                      {r.data.medicines.map((m, i) => (
                        <li key={i}>{[m.name, m.dose, m.frequency, m.duration].filter(Boolean).join(", ")}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

export function Records() {
  const { data, error } = useLoad<RecordRow[]>("/api/records");
  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Records</h1>
          <p className="sub">Confirmed documents, by the date of the investigation. Each date downloads as one PDF with the originals attached.</p>
        </div>
        <Link className="btn primary" to="/upload">Add documents</Link>
      </div>
      {error && <p className="alert error">{error}</p>}
      {data && data.length === 0 && <p className="panel muted">Nothing here yet. Add a photo or PDF of a prescription or result to start.</p>}
      {data && <RecordList records={data} pdfBase="/api/records/dates" />}
    </>
  );
}
