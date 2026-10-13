import { useState } from "react";
import { api, fmtDateTime } from "../api";
import { useAuth } from "../auth";
import { useLoad } from "../hooks";

interface Source {
  id: string;
  imap_host: string;
  username: string;
  sender_patterns: string[];
  last_polled_at: string | null;
  last_error: string | null;
}

const PROVIDERS: Record<string, string> = { "gmail.com": "imap.gmail.com", "yahoo.com": "imap.mail.yahoo.com", "outlook.com": "outlook.office365.com", "hotmail.com": "outlook.office365.com", "mail.ru": "imap.mail.ru" };

export function Settings() {
  const { me, refresh } = useAuth();
  const [pin, setPin] = useState("");
  const [note, setNote] = useState("");
  const sources = useLoad<Source[]>("/api/mail-sources");
  const [mail, setMail] = useState({ username: "", password: "", imap_host: "" });
  const [mailMsg, setMailMsg] = useState("");

  async function savePin() {
    await api.send("PUT", "/api/patient/approval-pin", { pin });
    setPin("");
    setNote("PIN saved.");
    await refresh();
  }

  async function addSource() {
    setMailMsg("");
    try {
      await api.send("POST", "/api/mail-sources", { ...mail, labs: ["synevo"] });
      setMail({ username: "", password: "", imap_host: "" });
      await sources.reload();
    } catch (e) {
      setMailMsg((e as Error).message);
    }
  }

  async function poll(id: string) {
    setMailMsg("Checking mailbox…");
    try {
      const r = await api.send<{ imported: number }>("POST", `/api/mail-sources/${id}/poll`);
      setMailMsg(`${r.imported} new result file(s) imported. They are waiting in "To review".`);
    } catch (e) {
      setMailMsg((e as Error).message);
    }
    await sources.reload();
  }

  return (
    <>
      <div className="pagehead">
        <h1>Settings</h1>
      </div>
      <div className="stack">
        <section className="panel stack">
          <h2>Approval PIN</h2>
          <p className="small muted">You enter this 6-digit PIN to approve a doctor's request, like confirming a payment in a banking app. {me?.has_pin ? "A PIN is set." : "No PIN yet."}</p>
          <div className="row">
            <input className="pin" style={{ maxWidth: 220 }} type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} />
            <button className="btn primary" disabled={pin.length !== 6} onClick={savePin}>{me?.has_pin ? "Change PIN" : "Set PIN"}</button>
          </div>
          {note && <p className="alert ok small">{note}</p>}
        </section>

        <section className="panel stack">
          <h2>Lab results by email</h2>
          <p className="small muted">
            Connect the mailbox where Synevo sends your results. MedData checks it for emails from the lab only, imports the attached results, and puts them in "To review".
            Use an app password from your email provider (for Gmail: Google Account → Security → App passwords), not your main password.
          </p>
          {(sources.data ?? []).map((s) => (
            <article className="item" key={s.id}>
              <div className="stack" style={{ gap: 4 }}>
                <strong>{s.username}</strong>
                <span className="small muted">
                  {s.imap_host} · from {s.sender_patterns.join(", ")} · {s.last_polled_at ? `checked ${fmtDateTime(s.last_polled_at)}` : "not checked yet"}
                </span>
                {s.last_error && <span className="small" style={{ color: "var(--high)" }}>{s.last_error}</span>}
              </div>
              <div className="row">
                <button className="btn sm" onClick={() => poll(s.id)}>Check now</button>
                <button className="btn sm danger" onClick={() => api.send("DELETE", `/api/mail-sources/${s.id}`).then(sources.reload)}>Disconnect</button>
              </div>
            </article>
          ))}
          <div className="grid2">
            <label className="field">
              Email address
              <input
                value={mail.username}
                onChange={(e) => {
                  const v = e.target.value;
                  const host = PROVIDERS[v.split("@")[1]?.toLowerCase() ?? ""];
                  setMail((m) => ({ ...m, username: v, imap_host: host ?? m.imap_host }));
                }}
              />
            </label>
            <label className="field">
              App password
              <input type="password" value={mail.password} onChange={(e) => setMail((m) => ({ ...m, password: e.target.value }))} />
            </label>
            <label className="field">
              IMAP server
              <input value={mail.imap_host} onChange={(e) => setMail((m) => ({ ...m, imap_host: e.target.value }))} placeholder="imap.gmail.com" />
            </label>
          </div>
          <div className="row">
            <button className="btn primary" disabled={!mail.username || !mail.password || !mail.imap_host} onClick={addSource}>Connect mailbox</button>
          </div>
          {mailMsg && <p className="alert small">{mailMsg}</p>}
        </section>
      </div>
    </>
  );
}
