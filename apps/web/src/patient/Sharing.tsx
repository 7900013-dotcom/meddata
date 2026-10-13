import { useState } from "react";
import { api, fmtDateTime, fullName } from "../api";
import { useAuth } from "../auth";
import { useLoad } from "../hooks";

interface Req {
  id: string;
  scope: string;
  duration_hours: number;
  reason: string | null;
  status: string;
  created_at: string;
  expires_at: string;
  first_name: string | null;
  last_name: string | null;
  specialty: string | null;
  institution: string | null;
  license_number: string | null;
}
interface Grant {
  id: string;
  scope: string;
  expires_at: string;
  active: boolean;
  first_name: string | null;
  last_name: string | null;
  specialty: string | null;
}
interface LogRow {
  action: string;
  at: string;
  first_name: string | null;
  last_name: string | null;
  detail: { what?: string };
}

const SCOPE: Record<string, string> = { all: "All records", labs: "Lab results only", prescriptions: "Prescriptions only" };
const ACTION: Record<string, string> = {
  "access.requested": "requested access",
  "access.approved": "approved access",
  "access.denied": "denied access",
  "access.revoked": "revoked access",
  "access.viewed": "viewed records",
  "access.pin_failed": "entered a wrong PIN",
};

export function Sharing() {
  const { me } = useAuth();
  const [share, setShare] = useState<{ qr_svg: string; short_code: string; expires_at: string } | null>(null);
  const [approving, setApproving] = useState<Req | null>(null);
  const reqs = useLoad<Req[]>("/api/access/requests");
  const grants = useLoad<Grant[]>("/api/access/grants");
  const log = useLoad<LogRow[]>("/api/access/log");
  const reloadAll = () => (reqs.reload(), grants.reload(), log.reload());
  const pending = (reqs.data ?? []).filter((r) => r.status === "pending");

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Doctors</h1>
          <p className="sub">A doctor sees your records only after you approve with your PIN, and only for the time you allow.</p>
        </div>
      </div>
      <div className="stack">
        {!me?.has_pin && <p className="alert small">Set an approval PIN in Settings before sharing.</p>}
        <section className="panel stack">
          <h2>Show a doctor your code</h2>
          {share ? (
            <div className="row" style={{ gap: 24, alignItems: "center" }}>
              <div className="qr" dangerouslySetInnerHTML={{ __html: share.qr_svg }} />
              <div className="stack" style={{ gap: 6 }}>
                <span className="small muted">Or read out this code</span>
                <span className="code">{share.short_code}</span>
                <span className="small muted">Works once, until {fmtDateTime(share.expires_at)}.</span>
              </div>
            </div>
          ) : (
            <p className="small muted">The doctor scans the QR code or types the code, then you get a request to approve here.</p>
          )}
          <div className="row">
            <button className="btn primary" disabled={!me?.has_pin} onClick={async () => setShare(await api.send("POST", "/api/share-tokens"))}>
              {share ? "New code" : "Create code"}
            </button>
            <button className="btn" onClick={reloadAll}>Check for requests</button>
          </div>
        </section>

        {pending.length > 0 && (
          <section className="stack">
            <h2>Waiting for your approval</h2>
            {pending.map((r) => (
              <article className="item" key={r.id} style={{ borderColor: "var(--accent)" }}>
                <div className="stack" style={{ gap: 4 }}>
                  <strong>Dr {fullName(r)}</strong>
                  <span className="small muted">{[r.specialty, r.institution, r.license_number && `licence ${r.license_number}`].filter(Boolean).join(" · ")}</span>
                  <span className="small">{SCOPE[r.scope]} for {r.duration_hours} h{r.reason ? ` · "${r.reason}"` : ""}</span>
                </div>
                <div className="row">
                  <button className="btn primary" onClick={() => setApproving(r)}>Approve</button>
                  <button className="btn danger" onClick={() => api.send("POST", `/api/access/requests/${r.id}/deny`).then(reloadAll)}>Deny</button>
                </div>
              </article>
            ))}
          </section>
        )}

        <section className="stack">
          <h2>Access you have given</h2>
          {(grants.data ?? []).filter((g) => g.active).length === 0 && <p className="small muted">No doctor has access right now.</p>}
          {(grants.data ?? []).filter((g) => g.active).map((g) => (
            <article className="item" key={g.id}>
              <div className="stack" style={{ gap: 4 }}>
                <strong>Dr {fullName(g)}</strong>
                <span className="small muted">{SCOPE[g.scope]} · until {fmtDateTime(g.expires_at)}</span>
              </div>
              <button className="btn danger" onClick={() => api.send("DELETE", `/api/access/grants/${g.id}`).then(reloadAll)}>Revoke</button>
            </article>
          ))}
        </section>

        <section className="panel stack">
          <h2>Access history</h2>
          {(log.data ?? []).length === 0 && <p className="small muted">Nothing yet.</p>}
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {(log.data ?? []).map((l, i) => (
              <li key={i}>
                {fmtDateTime(l.at)}: {l.first_name ? `${fullName(l)} ` : ""}{ACTION[l.action] ?? l.action}{l.detail.what ? ` (${l.detail.what})` : ""}
              </li>
            ))}
          </ul>
        </section>
      </div>
      {approving && <ApproveModal req={approving} onClose={() => (setApproving(null), reloadAll())} />}
    </>
  );
}

function ApproveModal({ req, onClose }: { req: Req; onClose: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  async function approve() {
    try {
      await api.send("POST", `/api/access/requests/${req.id}/approve`, { pin });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setPin("");
    }
  }
  return (
    <div className="modal-bg" role="dialog" aria-modal="true">
      <div className="modal stack">
        <h2>Confirm access</h2>
        <p className="small">
          Dr {fullName(req)} will see <strong>{SCOPE[req.scope].toLowerCase()}</strong> for <strong>{req.duration_hours} hours</strong>. Enter your PIN to approve.
        </p>
        <input className="pin" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" type="password" autoFocus />
        {error && <p className="alert error small">{error}</p>}
        <div className="row">
          <button className="btn primary" disabled={pin.length !== 6} onClick={approve}>Approve</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
