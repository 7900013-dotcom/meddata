import { useState } from "react";
import { api, fmtDateTime, fullName } from "../api";
import { useLoad } from "../hooks";
import { DEMO } from "../demo";
import { demo } from "../demo/shim";

interface Pending {
  id: string;
  idnp: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  license_number: string;
  specialty: string;
  institution: string;
  submitted_at: string;
}

export function Admin() {
  const q = useLoad<Pending[]>("/api/admin/certifications?status=pending");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const decide = (id: string, decision: "certify" | "reject") => api.send("POST", `/api/admin/certifications/${id}`, { decision, note: notes[id] || undefined }).then(q.reload);
  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Doctor certifications</h1>
          <p className="sub">Check each licence against the official register of medical staff before certifying.</p>
        </div>
      </div>
      {q.data?.length === 0 && <p className="panel muted">No pending submissions.</p>}
      <div className="list">
        {(q.data ?? []).map((d) => (
          <article className="item" key={d.id}>
            <div className="stack" style={{ gap: 4 }}>
              <strong>{fullName(d)}</strong>
              <span className="small muted">IDNP {d.idnp} · {d.email ?? "no email"} · submitted {fmtDateTime(d.submitted_at)}</span>
              <span className="small">Licence {d.license_number} · {d.specialty} · {d.institution}</span>
              <a className="small" href={DEMO ? demo.licenseUrl(d.id) || undefined : `/api/admin/certifications/${d.id}/license`} target="_blank" rel="noreferrer">Open licence file</a>
              <input placeholder="Note (shown to the doctor if rejected)" value={notes[d.id] ?? ""} onChange={(e) => setNotes({ ...notes, [d.id]: e.target.value })} />
            </div>
            <div className="row">
              <button className="btn primary" onClick={() => decide(d.id, "certify")}>Certify</button>
              <button className="btn danger" onClick={() => decide(d.id, "reject")}>Reject</button>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
