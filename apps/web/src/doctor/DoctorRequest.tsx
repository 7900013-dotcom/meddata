import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";

export function DoctorRequest() {
  const [params] = useSearchParams();
  const token = params.get("t");
  const code = params.get("code");
  const [scope, setScope] = useState("all");
  const [hours, setHours] = useState(24);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<{ ok?: boolean; error?: string }>({});

  async function send() {
    try {
      await api.send("POST", "/api/doctor/access-requests", { token: token ?? undefined, short_code: code ?? undefined, scope, duration_hours: hours, reason: reason || undefined });
      setState({ ok: true });
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  }

  if (state.ok)
    return (
      <div className="panel stack">
        <h1>Request sent</h1>
        <p className="muted">The patient has been notified and approves in their app with a PIN. The request expires if they don't answer.</p>
        <Link className="btn" to="/doctor">Back to patients</Link>
      </div>
    );
  return (
    <div className="panel stack">
      <h1>Request access</h1>
      <div className="grid2">
        <label className="field">
          What you need
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">All records</option>
            <option value="labs">Lab results only</option>
            <option value="prescriptions">Prescriptions only</option>
          </select>
        </label>
        <label className="field">
          For how long
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            <option value={2}>2 hours</option>
            <option value={24}>1 day</option>
            <option value={168}>1 week</option>
            <option value={720}>30 days</option>
          </select>
        </label>
      </div>
      <label className="field">Reason (shown to the patient)<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Cardiology consultation" /></label>
      {state.error && <p className="alert error small">{state.error}</p>}
      <div className="row"><button className="btn primary" disabled={!token && !code} onClick={send}>Send request</button></div>
    </div>
  );
}
