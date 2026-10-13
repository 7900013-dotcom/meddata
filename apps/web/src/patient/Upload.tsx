import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { prepareFile } from "../image";

export function Upload() {
  const nav = useNavigate();
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      for (const f of files) form.append("files", await prepareFile(f));
      await api.upload("/api/documents", form);
      nav("/inbox");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Add documents</h1>
          <p className="sub">Photos or PDFs of prescriptions, discharge notes and results. We keep the original and read it for you; you check the reading before it is saved.</p>
        </div>
      </div>
      <div className="panel stack">
        <input type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
        {files.length > 0 && (
          <ul className="small" style={{ margin: 0 }}>
            {files.map((f) => (
              <li key={f.name}>{f.name}</li>
            ))}
          </ul>
        )}
        <div className="row">
          <button className="btn primary" disabled={!files.length || busy} onClick={submit}>
            {busy ? "Uploading…" : `Upload ${files.length || ""}`}
          </button>
        </div>
        {error && <p className="alert error small">{error}</p>}
        <p className="small muted">Lab results that arrive by email can be imported automatically. Connect your mailbox in Settings.</p>
      </div>
    </>
  );
}
