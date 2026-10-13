import { useState } from "react";
import { api } from "./api";
import { useAuth } from "./auth";

export function Landing() {
  const { refresh } = useAuth();
  const [mode, setMode] = useState<"email" | "phone">("email");
  const [dest, setDest] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const payload = () => (mode === "email" ? { email: dest } : { phone: dest.replace(/\s/g, "") });

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="landing">
      <p className="eyebrow">MedData</p>
      <h1>Your medical records, readable and in one place</h1>
      <p className="muted" style={{ marginTop: 8 }}>
        Photograph prescriptions and results, get them transcribed and organised by date, and share them with a doctor only when you approve.
      </p>
      <div className="choices">
        <section className="panel stack">
          <h2>I'm a patient</h2>
          {!sent ? (
            <form className="stack" onSubmit={(e) => (e.preventDefault(), run(async () => (await api.send("POST", "/api/auth/otp/request", payload()), setSent(true))))}>
              <div className="seg">
                <button type="button" aria-pressed={mode === "email"} onClick={() => setMode("email")}>Email</button>
                <button type="button" aria-pressed={mode === "phone"} onClick={() => setMode("phone")}>Phone</button>
              </div>
              <label className="field">
                {mode === "email" ? "Email address" : "Phone number"}
                <input
                  value={dest}
                  onChange={(e) => setDest(e.target.value)}
                  type={mode === "email" ? "email" : "tel"}
                  placeholder={mode === "email" ? "you@example.com" : "+373 69 123 456"}
                  autoComplete={mode === "email" ? "email" : "tel"}
                  required
                />
              </label>
              <button className="btn primary" disabled={busy}>Send me a code</button>
            </form>
          ) : (
            <form className="stack" onSubmit={(e) => (e.preventDefault(), run(async () => (await api.send("POST", "/api/auth/otp/verify", { ...payload(), code }), await refresh())))}>
              <p className="small muted">We sent a 6-digit code to {dest}.</p>
              <label className="field">
                Code
                <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" required />
              </label>
              <button className="btn primary" disabled={busy || code.length !== 6}>Sign in</button>
              <button type="button" className="btn" onClick={() => (setSent(false), setCode(""))}>Use a different {mode}</button>
            </form>
          )}
          {error && <p className="alert error small">{error}</p>}
        </section>
        <section className="panel stack">
          <h2>I'm a doctor</h2>
          <p className="muted small">Sign in with MPass. After your licence is verified you can request access to a patient's records; the patient approves each request.</p>
          <a className="btn gov" href="/auth/mpass/login">Sign in with MPass</a>
        </section>
      </div>
    </div>
  );
}
