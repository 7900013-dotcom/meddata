import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError, KIND_LABEL, type Extraction, type LabValue, type Medicine } from "../api";
import { useLoad } from "../hooks";

type Check = { name: string; status: "matched" | "similar" | "not_found" | "register_not_loaded"; register_name?: string; suggestions?: string[] };
interface Doc {
  id: string;
  mime: string;
  original_name: string;
  status: string;
  extraction: Extraction | null;
  medicine_checks: Check[] | null;
}

const blank = (): Extraction => ({
  document_kind: "other",
  investigation_date: null,
  institution: null,
  doctor_name: null,
  title: "",
  summary: "",
  transcription: "",
  diagnoses: [],
  medicines: [],
  lab_values: [],
  uncertain_fields: [],
});
const emptyMed = (): Medicine => ({ name: "", dose: null, frequency: null, duration: null, route: null, notes: null, uncertain: false });
const emptyLab = (): LabValue => ({ test: "", value: null, value_text: "", unit: null, ref_low: null, ref_high: null, uncertain: false });
const numOrNull = (s: string) => (s.trim() === "" || isNaN(Number(s.replace(",", "."))) ? null : Number(s.replace(",", ".")));

function CheckChip({ c }: { c?: Check }) {
  if (!c) return null;
  if (c.status === "matched") return <span className="chip ok">In register</span>;
  if (c.status === "similar") return <span className="chip warn" title={c.suggestions?.join(", ")}>Not found. Did you mean {c.suggestions?.[0]}?</span>;
  if (c.status === "not_found") return <span className="chip high">Not in register</span>;
  return <span className="chip">Register not loaded</span>;
}

export function Review() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data: doc, error } = useLoad<Doc>(`/api/documents/${id}`);
  const [x, setX] = useState<Extraction>(blank());
  const [ack, setAck] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "warn"; text: string } | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);

  useEffect(() => {
    if (doc) {
      setX(doc.extraction ?? blank());
      setChecks(doc.medicine_checks ?? []);
    }
  }, [doc]);

  const set = <K extends keyof Extraction>(k: K, v: Extraction[K]) => setX((p) => ({ ...p, [k]: v }));
  const setMed = (i: number, patch: Partial<Medicine>) => set("medicines", x.medicines.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const setLab = (i: number, patch: Partial<LabValue>) => set("lab_values", x.lab_values.map((m, j) => (j === i ? { ...m, ...patch } : m)));

  async function confirm() {
    setMsg(null);
    try {
      await api.send("POST", `/api/documents/${id}/confirm`, { ...x, acknowledge_unverified_medicines: ack });
      nav("/records");
    } catch (e) {
      if (e instanceof ApiError && e.code === "unverified_medicines") {
        setChecks((prev) => [...prev.filter((c) => c.status === "matched"), ...(e.details as Check[])]);
        setMsg({ kind: "warn", text: e.message });
      } else setMsg({ kind: "error", text: (e as Error).message });
    }
  }

  async function discard() {
    if (!confirm_("Delete this document and its original?")) return;
    await api.send("DELETE", `/api/documents/${id}`);
    nav("/inbox");
  }

  if (error) return <p className="alert error">{error}</p>;
  if (!doc) return null;
  const original = `/api/documents/${id}/original`;
  const unverified = checks.some((c) => c.status === "similar" || c.status === "not_found");

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Check the reading</h1>
          <p className="sub">Compare with the original. Fix anything that's wrong; items marked [?] were hard to read.</p>
        </div>
      </div>
      <div className="review">
        <div className="original">{doc.mime === "application/pdf" ? <iframe src={original} title="Original" /> : <img src={original} alt="Original document" />}</div>
        <div className="stack">
          {x.uncertain_fields.length > 0 && (
            <div className="alert small">
              <strong>Please double-check:</strong>
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {x.uncertain_fields.map((u, i) => <li key={i}>{u}</li>)}
              </ul>
            </div>
          )}
          <div className="panel stack">
            <div className="grid2">
              <label className="field">
                Type
                <select value={x.document_kind} onChange={(e) => set("document_kind", e.target.value)}>
                  {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              <label className="field">
                Date of investigation
                <input type="date" value={x.investigation_date ?? ""} onChange={(e) => set("investigation_date", e.target.value || null)} required />
              </label>
              <label className="field">
                Title
                <input value={x.title} onChange={(e) => set("title", e.target.value)} />
              </label>
              <label className="field">
                Institution
                <input value={x.institution ?? ""} onChange={(e) => set("institution", e.target.value || null)} />
              </label>
              <label className="field">
                Doctor
                <input value={x.doctor_name ?? ""} onChange={(e) => set("doctor_name", e.target.value || null)} />
              </label>
            </div>
            <label className="field">
              Summary
              <input value={x.summary} onChange={(e) => set("summary", e.target.value)} />
            </label>
          </div>

          <div className="panel stack">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3>Medicines</h3>
              <button className="btn sm" onClick={() => set("medicines", [...x.medicines, emptyMed()])}>Add</button>
            </div>
            {x.medicines.length === 0 && <p className="small muted">None.</p>}
            {x.medicines.map((m, i) => (
              <div key={i} className="stack" style={{ gap: 6, paddingBottom: 10, borderBottom: "1px solid var(--line)" }}>
                <div className="row">
                  <input style={{ flex: 2, minWidth: 160 }} value={m.name} onChange={(e) => setMed(i, { name: e.target.value })} placeholder="Name" />
                  <CheckChip c={checks.find((c) => c.name === m.name)} />
                  {m.uncertain && <span className="chip warn">Hard to read</span>}
                </div>
                <div className="grid2">
                  <input value={m.dose ?? ""} onChange={(e) => setMed(i, { dose: e.target.value || null })} placeholder="Dose" />
                  <input value={m.frequency ?? ""} onChange={(e) => setMed(i, { frequency: e.target.value || null })} placeholder="How often" />
                  <input value={m.duration ?? ""} onChange={(e) => setMed(i, { duration: e.target.value || null })} placeholder="For how long" />
                </div>
                <button className="btn sm danger" style={{ alignSelf: "flex-start" }} onClick={() => set("medicines", x.medicines.filter((_, j) => j !== i))}>Remove</button>
              </div>
            ))}
          </div>

          <div className="panel stack">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3>Results</h3>
              <button className="btn sm" onClick={() => set("lab_values", [...x.lab_values, emptyLab()])}>Add</button>
            </div>
            {x.lab_values.length === 0 ? (
              <p className="small muted">None.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="vals">
                  <thead>
                    <tr><th>Test</th><th>Result</th><th>Unit</th><th>Range</th><th /></tr>
                  </thead>
                  <tbody>
                    {x.lab_values.map((v, i) => (
                      <tr key={i} style={v.uncertain ? { background: "var(--warn-soft)" } : undefined}>
                        <td><input value={v.test} onChange={(e) => setLab(i, { test: e.target.value })} style={{ minWidth: 150 }} /></td>
                        <td><input value={v.value_text} onChange={(e) => setLab(i, { value_text: e.target.value, value: numOrNull(e.target.value) })} style={{ minWidth: 80 }} /></td>
                        <td><input value={v.unit ?? ""} onChange={(e) => setLab(i, { unit: e.target.value || null })} style={{ width: 80 }} /></td>
                        <td className="row" style={{ flexWrap: "nowrap" }}>
                          <input value={v.ref_low ?? ""} onChange={(e) => setLab(i, { ref_low: numOrNull(e.target.value) })} style={{ width: 70 }} />
                          <input value={v.ref_high ?? ""} onChange={(e) => setLab(i, { ref_high: numOrNull(e.target.value) })} style={{ width: 70 }} />
                        </td>
                        <td><button className="btn sm danger" onClick={() => set("lab_values", x.lab_values.filter((_, j) => j !== i))}>×</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <details className="panel">
            <summary>Full transcription</summary>
            <textarea value={x.transcription} onChange={(e) => set("transcription", e.target.value)} style={{ marginTop: 10 }} />
          </details>

          {unverified && (
            <label className="row small">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ width: "auto" }} />
              I checked the medicine names that aren't in the register against the original.
            </label>
          )}
          {msg && <p className={`alert ${msg.kind === "error" ? "error" : ""} small`}>{msg.text}</p>}
          <div className="row">
            <button className="btn primary" disabled={!x.investigation_date || !x.title} onClick={confirm}>Confirm and save</button>
            <button className="btn danger" onClick={discard}>Delete</button>
          </div>
        </div>
      </div>
    </>
  );
}

const confirm_ = (q: string) => window.confirm(q);
