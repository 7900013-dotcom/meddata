import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { demo } from "./shim";

/** Floating panel, demo build only: switch between patient, doctor and admin in one browser. */
export function DemoPanel() {
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  // Open on the landing page, folded to a small button everywhere else so it never covers the app.
  const [open, setOpen] = useState(loc.pathname === "/");
  useEffect(() => setOpen(loc.pathname === "/"), [loc.pathname]);
  const [armed, setArmed] = useState(false);
  const go = async (role: "patient" | "doctor" | "admin") => {
    demo.switchTo(role);
    await refresh();
    nav(role === "patient" ? "/records" : role === "doctor" ? "/doctor" : "/admin");
  };
  return (
    <div className={`demo-panel ${open ? "" : "closed"}`}>
      <button className="demo-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? "Hide" : "Demo"}
      </button>
      {open && (
        <div className="stack" style={{ gap: 8 }}>
          <strong>Live demo</strong>
          <span className="small muted">Everything runs in your browser with sample data. Readings are samples; the hosted app reads real documents with Claude.</span>
          <span className="small">Try it as:</span>
          <div className="row">
            <button className={`btn sm ${me?.role === "patient" ? "primary" : ""}`} onClick={() => go("patient")}>Patient</button>
            <button className={`btn sm ${me?.role === "doctor" ? "primary" : ""}`} onClick={() => go("doctor")}>Doctor</button>
            <button className={`btn sm ${me?.role === "admin" ? "primary" : ""}`} onClick={() => go("admin")}>Admin</button>
          </div>
          <span className="small muted">Patient Ana's PIN: 123456. The doctor is certified by the admin, then asks the patient for access with her code.</span>
          <button
            className="btn sm danger"
            onClick={async () => {
              if (!armed) return setArmed(true);
              demo.reset();
              setArmed(false);
              await refresh();
              nav("/");
            }}
          >
            {armed ? "Really clear all demo data?" : "Reset demo data"}
          </button>
        </div>
      )}
    </div>
  );
}
