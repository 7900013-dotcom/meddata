import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { demo } from "./shim";

/** Stand-in for the MPass sign-in page (the server renders the same form in MPASS_MODE=mock). */
export function MPassMock() {
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [f, setF] = useState({ idnp: "2001234567890", firstName: "Elena", lastName: "Rusu", email: "elena.rusu@example.com" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="landing" style={{ maxWidth: 460 }}>
      <p className="eyebrow">MPass (stand-in)</p>
      <h1>Sign in with your e-ID</h1>
      <p className="muted small">This page stands in for MPass, the Moldovan government identity service, until MedData is registered with the e-Government Agency.</p>
      <form
        className="panel stack"
        onSubmit={async (e) => {
          e.preventDefault();
          demo.mpassSignIn(f);
          await refresh();
          nav("/doctor");
        }}
      >
        <label className="field">IDNP<input value={f.idnp} onChange={set("idnp")} required pattern="\d{13}" /></label>
        <label className="field">First name<input value={f.firstName} onChange={set("firstName")} /></label>
        <label className="field">Last name<input value={f.lastName} onChange={set("lastName")} /></label>
        <label className="field">Email<input value={f.email} onChange={set("email")} /></label>
        <button className="btn gov">Sign in</button>
      </form>
    </div>
  );
}
