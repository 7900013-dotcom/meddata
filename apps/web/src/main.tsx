import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import "./styles.css";
import { AuthProvider, useAuth } from "./auth";
import type { Me } from "./api";
import { Landing } from "./Landing";
import { Records } from "./patient/Records";
import { Upload } from "./patient/Upload";
import { Inbox } from "./patient/Inbox";
import { Review } from "./patient/Review";
import { Trends } from "./patient/Trends";
import { Sharing } from "./patient/Sharing";
import { Settings } from "./patient/Settings";
import { DoctorHome } from "./doctor/DoctorHome";
import { DoctorRequest } from "./doctor/DoctorRequest";
import { DoctorPatient } from "./doctor/DoctorPatient";
import { Admin } from "./admin/Admin";

const NAV: Record<Me["role"], [string, string][]> = {
  patient: [["/records", "Records"], ["/upload", "Add"], ["/inbox", "To review"], ["/trends", "Trends"], ["/sharing", "Doctors"], ["/settings", "Settings"]],
  doctor: [["/doctor", "Patients"]],
  admin: [["/admin", "Certifications"]],
};

function Shell({ role, children }: { role: Me["role"]; children: ReactNode }) {
  const { me, loading, logout } = useAuth();
  const loc = useLocation();
  if (loading) return null;
  if (!me) {
    // e.g. a doctor scanning a patient's QR before signing in: come back here afterwards.
    sessionStorage.setItem("returnTo", loc.pathname + loc.search);
    return <Navigate to="/" replace />;
  }
  const returnTo = sessionStorage.getItem("returnTo");
  if (returnTo) {
    sessionStorage.removeItem("returnTo");
    if (returnTo !== loc.pathname + loc.search) return <Navigate to={returnTo} replace />;
  }
  if (me.role !== role) return <Navigate to={NAV[me.role][0][0]} replace />;
  return (
    <>
      <header className="topbar">
        <div className="brand">MedData</div>
        <div className="topright">
          <span className="who">{me.first_name ? `${me.first_name} ${me.last_name ?? ""}` : me.email ?? me.phone}</span>
          <button className="btn sm" onClick={logout}>Sign out</button>
        </div>
      </header>
      <div className="shell">
        <nav className="side">
          {NAV[role].map(([to, label]) => (
            <NavLink key={to} to={to}>
              {label}
            </NavLink>
          ))}
        </nav>
        <main>{children}</main>
      </div>
    </>
  );
}

function Home() {
  const { me, loading } = useAuth();
  if (loading) return null;
  return me ? <Navigate to={NAV[me.role][0][0]} replace /> : <Landing />;
}

const p = (el: ReactNode) => <Shell role="patient">{el}</Shell>;
const d = (el: ReactNode) => <Shell role="doctor">{el}</Shell>;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/records" element={p(<Records />)} />
          <Route path="/upload" element={p(<Upload />)} />
          <Route path="/inbox" element={p(<Inbox />)} />
          <Route path="/review/:id" element={p(<Review />)} />
          <Route path="/trends" element={p(<Trends />)} />
          <Route path="/sharing" element={p(<Sharing />)} />
          <Route path="/settings" element={p(<Settings />)} />
          <Route path="/doctor" element={d(<DoctorHome />)} />
          <Route path="/doctor/request" element={d(<DoctorRequest />)} />
          <Route path="/doctor/patients/:pid" element={d(<DoctorPatient />)} />
          <Route path="/admin" element={<Shell role="admin"><Admin /></Shell>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  </StrictMode>,
);
