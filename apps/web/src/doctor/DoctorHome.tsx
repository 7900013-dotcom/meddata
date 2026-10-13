import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, fmtDateTime, fullName } from "../api";
import { useLoad } from "../hooks";

interface DoctorMe {
  status: "unverified" | "pending" | "certified" | "rejected" | "suspended";
  license_number: string | null;
  specialty: string | null;
  institution: string | null;
  review_note: string | null;
}
interface Patient {
  grant_id: string;
  patient_id: string;
  scope: string;
  expires_at: string;
  first_name: string | null;
  last_name: string | null;
  birth_date: string | null;
}
interface Req {
  id: string;
  status: string;
  scope: string;
  created_at: string;
  first_name: string | null;
  last_name: string | null;
}

export function DoctorHome() {
  const me = useLoad<DoctorMe>("/api/doctor/me");
  if (!me.data) return null;
  if (me.data.status !== "certified") return <Certification me={me.data} onDone={me.reload} />;
  return <CertifiedHome />;
}

function CertifiedHome() {
  const nav = useNavigate();
  const patients = useLoad<Patient[]>("/api/doctor/patients");
  const reqs = useLoad<Req[]>("/api/doctor/access-requests");
  const [code, setCode] = useState("");
  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Patients</h1>
          <p className="sub">Scan the patient's QR code with your phone camera, or type the code they read out.</p>
        </div>
      </div>
      <div className="stack">
        <section className="panel row">
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCD-EFGH" style={{ maxWidth: 220, fontFamily: "var(--font-mono)" }} />
          <button className="btn primary" disabled={code.replace(/\W/g, "").length !== 8} onClick={() => nav(`/doctor/request?code=${encodeURIComponent(code)}`)}>Continue</button>
        </section>
        <section className="stack">
          <h2>With access now</h2>
          {(patients.data ?? []).length === 0 && <p className="small muted">No patients have given you access right now.</p>}
          {(patients.data ?? []).map((p) => (
            <Link className="item" key={p.grant_id} to={`/doctor/patients/${p.patient_id}`} style={{ textDecoration: "none", color: "inherit" }}>
              <strong>{fullName(p)}</strong>
              <span className="small muted">until {fmtDateTime(p.expires_at)}</span>
            </Link>
          ))}
        </section>
        <section className="panel stack">
          <h2>Your requests</h2>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {(reqs.data ?? []).map((r) => (
              <li key={r.id}>{fmtDateTime(r.created_at)}: {fullName(r)}, {r.status}</li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}

function Certification({ me, onDone }: { me: DoctorMe; onDone: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (me.status === "pending")
    return (
      <div className="panel stack">
        <h1>Verification in progress</h1>
        <p className="muted">We are checking licence {me.license_number} against the register. You can request access to patients once it is approved.</p>
      </div>
    );
  if (me.status === "suspended") return <p className="alert error">Your account is suspended. Contact support.</p>;
  return (
    <form
      className="panel stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await api.upload("/api/doctor/certification", new FormData(e.currentTarget));
          onDone();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1>Confirm you are a practising doctor</h1>
      <p className="muted">MPass confirmed who you are. We also need your licence to confirm you practise medicine. Only verified doctors can ask patients for access.</p>
      {me.status === "rejected" && <p className="alert error small">Your previous submission was not approved{me.review_note ? `: ${me.review_note}` : "."}</p>}
      <div className="grid2">
        <label className="field">Licence number<input name="license_number" required defaultValue={me.license_number ?? ""} /></label>
        <label className="field">Specialty<input name="specialty" required defaultValue={me.specialty ?? ""} /></label>
        <label className="field">Institution<input name="institution" required defaultValue={me.institution ?? ""} /></label>
        <label className="field">Photo or PDF of your licence<input name="license" type="file" accept="image/jpeg,image/png,application/pdf" required /></label>
      </div>
      {error && <p className="alert error small">{error}</p>}
      <div className="row"><button className="btn primary" disabled={busy}>Submit for verification</button></div>
    </form>
  );
}
