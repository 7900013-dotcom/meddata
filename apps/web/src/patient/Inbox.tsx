import { useEffect } from "react";
import { Link } from "react-router-dom";
import { api, fmtDateTime } from "../api";
import { useLoad } from "../hooks";

interface Doc {
  id: string;
  original_name: string;
  status: string;
  error: string | null;
  source: string;
  email_from: string | null;
  created_at: string;
  title: string | null;
  investigation_date: string | null;
}

const ERRORS: Record<string, string> = {
  password_protected: "This PDF is password-protected. Open it, save an unprotected copy, and upload that instead.",
  image_too_large: "The image is too large to read. Upload a smaller photo.",
  refused: "This document could not be read automatically. Open it to enter the details by hand.",
  extraction_failed: "Reading failed. Try again.",
};

export function Inbox() {
  const { data, error, reload } = useLoad<Doc[]>("/api/documents");
  const pending = (data ?? []).filter((d) => d.status !== "confirmed");
  useEffect(() => {
    if (!pending.some((d) => d.status === "extracting" || d.status === "uploaded")) return;
    const t = setTimeout(reload, 3000);
    return () => clearTimeout(t);
  }, [data, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>To review</h1>
          <p className="sub">Check each reading against the original before it becomes part of your records.</p>
        </div>
      </div>
      {error && <p className="alert error">{error}</p>}
      {data && pending.length === 0 && <p className="panel muted">Nothing waiting for review.</p>}
      <div className="list">
        {pending.map((d) => (
          <article className="item" key={d.id}>
            <div className="stack" style={{ gap: 4 }}>
              <strong>{d.title ?? d.original_name}</strong>
              <span className="small muted">
                {d.source === "email" ? `From ${d.email_from}` : "Uploaded"} · {fmtDateTime(d.created_at)}
              </span>
              {d.status === "failed" && <span className="small" style={{ color: "var(--high)" }}>{ERRORS[d.error ?? ""] ?? d.error}</span>}
            </div>
            <div className="row">
              {d.status === "extracting" || d.status === "uploaded" ? (
                <span className="chip warn">Reading…</span>
              ) : (
                <Link className="btn primary sm" to={`/review/${d.id}`}>Review</Link>
              )}
              {d.status === "failed" && d.error === "extraction_failed" && (
                <button className="btn sm" onClick={() => api.send("POST", `/api/documents/${d.id}/retry`).then(reload)}>Try again</button>
              )}
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
