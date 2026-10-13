/**
 * Demo backend that runs entirely in the browser. It answers the same /api routes
 * as the real server, keeps its data in localStorage, and returns sample readings
 * instead of calling Claude. Built only when VITE_DEMO=1, so the hosted app never
 * includes it.
 */
import QRCode from "qrcode";
import type { Extraction, LabValue, Medicine, RecordRow, Series } from "../api";

type Role = "patient" | "doctor" | "admin";
interface User {
  id: string;
  role: Role;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  idnp: string | null;
  birth_date: string | null;
  pin: string | null;
  doctor: { status: "unverified" | "pending" | "certified" | "rejected" | "suspended"; license_number: string | null; specialty: string | null; institution: string | null; review_note: string | null; license_data: string | null; submitted_at: string | null } | null;
}
interface Doc {
  id: string;
  patient_id: string;
  original_name: string;
  mime: string;
  status: "uploaded" | "extracting" | "needs_review" | "confirmed" | "failed";
  error: string | null;
  source: "upload" | "email";
  email_from: string | null;
  created_at: string;
  extraction: Extraction | null;
  medicine_checks: Check[] | null;
  data: string | null; // data: URL of the original
}
interface Rec extends RecordRow {
  patient_id: string;
  transcription: string;
  confirmed_at: string;
}
interface Lab {
  record_id: string;
  patient_id: string;
  test: string;
  value: number | null;
  value_text: string;
  unit: string | null;
  ref_low: number | null;
  ref_high: number | null;
  date: string;
}
interface State {
  users: User[];
  session: string | null;
  documents: Doc[];
  records: Rec[];
  labs: Lab[];
  share_tokens: { patient_id: string; token: string; code: string; expires_at: string; used: boolean }[];
  access_requests: { id: string; patient_id: string; doctor_id: string; scope: string; duration_hours: number; reason: string | null; status: string; created_at: string; expires_at: string }[];
  grants: { id: string; patient_id: string; doctor_id: string; scope: string; expires_at: string; revoked: boolean; created_at: string }[];
  audit: { patient_id: string; doctor_id: string | null; action: string; at: string; detail: Record<string, unknown> }[];
  mail_sources: { id: string; patient_id: string; imap_host: string; username: string; sender_patterns: string[]; last_polled_at: string | null; last_error: string | null }[];
  otp: { dest: string; code: string } | null;
  seeded: boolean;
}
type Check = { name: string; status: "matched" | "similar" | "not_found"; register_name?: string; suggestions?: string[] };

const KEY = "meddata-demo-v1";
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const plusMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

function fresh(): State {
  return { users: [], session: null, documents: [], records: [], labs: [], share_tokens: [], access_requests: [], grants: [], audit: [], mail_sources: [], otp: null, seeded: false };
}
let state: State = load();
function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...fresh(), ...JSON.parse(raw) };
  } catch {}
  return fresh();
}
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Quota exceeded (large photos): drop originals of confirmed documents and retry once.
    for (const d of state.documents) if (d.status === "confirmed") d.data = null;
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {}
  }
}

class Http extends Error {
  constructor(public status: number, public code: string, public msg?: string, public details?: unknown) {
    super(code);
  }
}
const me = () => state.users.find((u) => u.id === state.session) ?? null;
const need = (role?: Role) => {
  const u = me();
  if (!u) throw new Http(401, "unauthenticated", "Please sign in.");
  if (role && u.role !== role) throw new Http(403, "forbidden");
  return u;
};

// ---------- sample content ----------

const REGISTER = ["Atorvastatină", "Metformin", "Paracetamol", "Ibuprofen", "Amoxicilină", "Omeprazol", "Enalapril", "Bisoprolol", "Aspirin Cardio", "Levotiroxină", "Amlodipină", "Azitromicină", "Diclofenac", "Nimesulid", "Losartan", "Rosuvastatină", "Vitamina D3", "Magne B6"];
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
function lev(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
function checkMedicines(meds: Pick<Medicine, "name">[]): Check[] {
  return meds
    .filter((m) => m.name.trim())
    .map((m) => {
      const n = fold(m.name).replace(/\s+\d.*$/, "");
      const exact = REGISTER.find((r) => fold(r) === n || n.startsWith(fold(r) + " ") || n === fold(r));
      if (exact) return { name: m.name, status: "matched", register_name: exact };
      const near = REGISTER.map((r) => ({ r, d: lev(fold(r), n) / Math.max(n.length, 1) })).filter((x) => x.d <= 0.34).sort((a, b) => a.d - b.d);
      if (near.length) return { name: m.name, status: "similar", suggestions: near.slice(0, 3).map((x) => x.r) };
      return { name: m.name, status: "not_found" };
    });
}

/** Draws a scan-like page so every demo record has an "original" to compare with. */
function scanImage(lines: string[], heading: string): string {
  const c = document.createElement("canvas");
  c.width = 1000;
  c.height = 1300;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f6f3ec";
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#fffdf8";
  g.fillRect(40, 40, 920, 1220);
  g.fillStyle = "#1d2a44";
  g.font = "bold 34px Georgia, serif";
  g.fillText(heading, 90, 130);
  g.fillStyle = "#6b7280";
  g.fillRect(90, 150, 820, 2);
  g.fillStyle = "#1f2937";
  g.font = "26px 'Courier New', monospace";
  lines.forEach((l, i) => g.fillText(l, 90, 210 + i * 44));
  g.fillStyle = "#9ca3af";
  g.font = "italic 20px Georgia, serif";
  g.fillText("Semnătura / ștampila", 640, 1190);
  g.strokeStyle = "#374151";
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(640, 1170);
  g.bezierCurveTo(700, 1100, 760, 1200, 860, 1140);
  g.stroke();
  return c.toDataURL("image/jpeg", 0.85);
}

const labSample = (date: string, vals: [string, number, string, number, number][], uncertain = ""): Extraction => ({
  document_kind: "lab_result",
  investigation_date: date,
  institution: "Synevo Moldova",
  doctor_name: null,
  title: "Analize de sânge",
  summary: "Routine blood panel.",
  transcription: vals.map(([t, v, u, lo, hi]) => `${t} ${v} ${u} (${lo}-${hi})`).join("\n"),
  diagnoses: [],
  medicines: [],
  lab_values: vals.map(([test, value, unit, ref_low, ref_high]) => ({ test, value, value_text: String(value), unit, ref_low, ref_high, uncertain: test === uncertain })),
  uncertain_fields: uncertain ? [`${uncertain}: the last digit is smudged`] : [],
});

function demoExtraction(name: string, i: number): Extraction {
  const today = new Date().toISOString().slice(0, 10);
  if (i % 2 === 1)
    return {
      document_kind: "prescription",
      investigation_date: today,
      institution: "IMSP Clinica Universitară",
      doctor_name: "Dr. Ion Cebotari",
      title: "Rețetă (sample reading)",
      summary: `Sample reading of "${name}". The hosted app reads the real content with Claude.`,
      transcription: "Rp: Atorvastatină 20 mg, 1 compr. seara, 3 luni\nMetformin 500 mg, 1 compr. x 2/zi, 3 luni\nVitamina D3 2000 UI, 1/zi",
      diagnoses: ["Hipercolesterolemie", "Prediabet"],
      medicines: [
        { name: "Atorvastatină", dose: "20 mg", frequency: "1 tablet in the evening", duration: "3 months", route: "oral", notes: null, uncertain: false },
        { name: "Metformin", dose: "500 mg", frequency: "1 tablet twice a day", duration: "3 months", route: "oral", notes: "with meals", uncertain: false },
        { name: "Vitamna D3", dose: "2000 IU", frequency: "once a day", duration: null, route: "oral", notes: null, uncertain: true },
      ],
      lab_values: [],
      uncertain_fields: ["Third medicine name is hard to read"],
    };
  const x = labSample(today, [["Hemoglobina", 13.1, "g/dL", 12, 15.5], ["Glucoza", 6.3, "mmol/L", 3.9, 5.8], ["Colesterol total", 5.4, "mmol/L", 0, 5.2], ["TSH", 1.8, "mIU/L", 0.4, 4.0]], "Glucoza");
  x.title = "Analize de sânge (sample reading)";
  x.summary = `Sample reading of "${name}". The hosted app reads the real content with Claude.`;
  return x;
}

function confirmRecord(patientId: string, doc: Doc, x: Extraction) {
  const rec: Rec = {
    id: uid(),
    patient_id: patientId,
    document_id: doc.id,
    kind: x.document_kind,
    investigation_date: x.investigation_date!,
    institution: x.institution,
    doctor_name: x.doctor_name,
    title: x.title,
    summary: x.summary || null,
    data: { medicines: x.medicines, diagnoses: x.diagnoses },
    original_name: doc.original_name,
    source: doc.source,
    transcription: x.transcription,
    confirmed_at: now(),
  };
  state.records.push(rec);
  for (const v of x.lab_values) state.labs.push({ record_id: rec.id, patient_id: patientId, test: v.test, value: v.value, value_text: v.value_text, unit: v.unit, ref_low: v.ref_low, ref_high: v.ref_high, date: x.investigation_date! });
  doc.status = "confirmed";
  doc.extraction = x;
}

function seedPatient(u: User) {
  const d1 = labSample("2026-06-12", [["Hemoglobina", 12.4, "g/dL", 12, 15.5], ["Glucoza", 5.1, "mmol/L", 3.9, 5.8], ["Colesterol total", 5.9, "mmol/L", 0, 5.2], ["TSH", 2.1, "mIU/L", 0.4, 4.0]]);
  const d2 = labSample("2026-09-03", [["Hemoglobina", 13.1, "g/dL", 12, 15.5], ["Glucoza", 6.3, "mmol/L", 3.9, 5.8], ["Colesterol total", 5.4, "mmol/L", 0, 5.2], ["TSH", 1.8, "mIU/L", 0.4, 4.0]]);
  const rx: Extraction = {
    document_kind: "prescription",
    investigation_date: "2026-09-03",
    institution: "IMSP Clinica Universitară",
    doctor_name: "Dr. Ion Cebotari",
    title: "Rețetă: statină și metformin",
    summary: "Started a statin for cholesterol and metformin for raised fasting glucose; recheck in 3 months.",
    transcription: "Rp: Atorvastatină 20 mg, 1 compr. seara, 3 luni\nMetformin 500 mg, 1 compr. x 2/zi, 3 luni",
    diagnoses: ["Hipercolesterolemie", "Prediabet"],
    medicines: [
      { name: "Atorvastatină", dose: "20 mg", frequency: "1 tablet in the evening", duration: "3 months", route: "oral", notes: null, uncertain: false },
      { name: "Metformin", dose: "500 mg", frequency: "1 tablet twice a day", duration: "3 months", route: "oral", notes: "with meals", uncertain: false },
    ],
    lab_values: [],
    uncertain_fields: [],
  };
  const mk = (x: Extraction, name: string, created: string, source: Doc["source"] = "upload"): Doc => ({
    id: uid(),
    patient_id: u.id,
    original_name: name,
    mime: "image/jpeg",
    status: "needs_review",
    error: null,
    source,
    email_from: source === "email" ? "rezultate@synevo.md" : null,
    created_at: created,
    extraction: x,
    medicine_checks: checkMedicines(x.medicines),
    data: scanImage([x.institution ?? "", `Data: ${x.investigation_date}`, "", ...x.transcription.split("\n")], x.document_kind === "prescription" ? "REȚETĂ MEDICALĂ" : "BULETIN DE ANALIZE"),
  });
  const docs = [mk(d1, "synevo-iunie.jpg", "2026-06-13T09:12:00Z"), mk(d2, "synevo-septembrie.jpg", "2026-09-04T17:40:00Z", "email"), mk(rx, "reteta.jpg", "2026-09-04T17:45:00Z")];
  for (const d of docs) {
    state.documents.push(d);
    confirmRecord(u.id, d, d.extraction!);
  }
  // One more waiting in "To review", so the review step is visible straight away.
  const pending = mk(demoExtraction("consult-cardiolog.jpg", 1), "consult-cardiolog.jpg", now());
  pending.extraction!.investigation_date = new Date().toISOString().slice(0, 10);
  state.documents.push(pending);
}

// ---------- toast (stands in for the SMS / email) ----------
export function toast(text: string, ms = 12000) {
  let el = document.getElementById("demo-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "demo-toast";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.className = "show";
  setTimeout(() => el!.classList.remove("show"), ms);
}

// ---------- route handling ----------

const patientRecords = (pid: string, scope = "all"): RecordRow[] =>
  state.records
    .filter((r) => r.patient_id === pid && (scope === "all" || (scope === "labs" ? r.kind === "lab_result" : r.kind === "prescription")))
    .sort((a, b) => b.investigation_date.localeCompare(a.investigation_date) || b.confirmed_at.localeCompare(a.confirmed_at))
    .map(({ patient_id: _p, transcription: _t, confirmed_at: _c, ...row }) => row);

const trends = (pid: string): Series[] => {
  const m = new Map<string, Series>();
  for (const l of state.labs.filter((x) => x.patient_id === pid).sort((a, b) => a.test.localeCompare(b.test) || a.date.localeCompare(b.date))) {
    const k = l.test.toLowerCase();
    if (!m.has(k)) m.set(k, { test: l.test, unit: l.unit, points: [] });
    m.get(k)!.points.push({ date: l.date, value: l.value, value_text: l.value_text, ref_low: l.ref_low, ref_high: l.ref_high });
  }
  return [...m.values()].filter((s) => s.points.length > 0);
};

const activeGrant = (doctorId: string, pid: string) => state.grants.find((g) => g.doctor_id === doctorId && g.patient_id === pid && !g.revoked && g.expires_at > now());
const docRow = (d: Doc) => ({ id: d.id, original_name: d.original_name, status: d.status, error: d.error, source: d.source, email_from: d.email_from, created_at: d.created_at, title: d.extraction?.title ?? null, investigation_date: d.extraction?.investigation_date ?? null });
const withDoctor = (doctorId: string) => {
  const d = state.users.find((u) => u.id === doctorId);
  return { first_name: d?.first_name ?? null, last_name: d?.last_name ?? null, specialty: d?.doctor?.specialty ?? null, institution: d?.doctor?.institution ?? null, license_number: d?.doctor?.license_number ?? null };
};
const meRow = (u: User) => ({ id: u.id, role: u.role, email: u.email, phone: u.phone, first_name: u.first_name, last_name: u.last_name, has_pin: !!u.pin, doctor_status: u.doctor?.status ?? null });

async function fileToDataUrl(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });
}

function expireRequests() {
  for (const r of state.access_requests) if (r.status === "pending" && r.expires_at < now()) r.status = "expired";
}

async function handle(method: string, url: string, body: unknown): Promise<unknown> {
  const u = new URL(url, location.origin);
  const p = u.pathname.replace(/^.*?(?=\/api\/)/, "");
  const b = (body ?? {}) as Record<string, any>;
  const m = (re: RegExp) => p.match(re);
  let r: RegExpMatchArray | null;
  expireRequests();

  if (p === "/api/me") return { user: me() ? meRow(me()!) : null };
  if (p === "/api/auth/logout") return ((state.session = null), {});
  if (p === "/api/auth/otp/request") {
    const dest = (b.email ?? b.phone ?? "").toString().toLowerCase();
    if (!dest) throw new Http(400, "invalid_input");
    const code = String(Math.floor(100000 + Math.random() * 900000));
    state.otp = { dest, code };
    toast(`${b.email ? "Email" : "SMS"} to ${dest} (demo): your MedData code is ${code}`, 60000);
    return {};
  }
  if (p === "/api/auth/otp/verify") {
    const dest = (b.email ?? b.phone ?? "").toString().toLowerCase();
    if (!state.otp || state.otp.dest !== dest || state.otp.code !== b.code) throw new Http(401, "wrong_code");
    let user = state.users.find((x) => (b.email ? x.email === dest : x.phone === dest));
    if (user && user.role !== "patient") throw new Http(403, "doctors_use_mpass");
    if (!user) {
      user = { id: uid(), role: "patient", email: b.email ? dest : null, phone: b.phone ? dest : null, first_name: null, last_name: null, idnp: null, birth_date: null, pin: null, doctor: null };
      state.users.push(user);
      seedPatient(user);
    }
    state.session = user.id;
    state.otp = null;
    document.getElementById("demo-toast")?.classList.remove("show");
    return {};
  }

  // ----- patient -----
  if (p === "/api/documents" && method === "GET") {
    const u = need("patient");
    return state.documents.filter((d) => d.patient_id === u.id).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(docRow);
  }
  if (p === "/api/documents" && method === "POST") {
    const u = need("patient");
    const form = body as FormData;
    const files = form.getAll("files") as File[];
    const created: Doc[] = [];
    for (const f of files) {
      const d: Doc = { id: uid(), patient_id: u.id, original_name: f.name, mime: f.type, status: "extracting", error: null, source: "upload", email_from: null, created_at: now(), extraction: null, medicine_checks: null, data: await fileToDataUrl(f) };
      state.documents.push(d);
      created.push(d);
    }
    save();
    created.forEach((d, i) =>
      setTimeout(() => {
        const x = demoExtraction(d.original_name, i);
        d.extraction = x;
        d.medicine_checks = checkMedicines(x.medicines);
        d.status = "needs_review";
        save();
      }, 2500 + i * 800),
    );
    return { documents: created.map(docRow) };
  }
  if ((r = m(/^\/api\/documents\/([^/]+)$/))) {
    const u = need("patient");
    const d = state.documents.find((x) => x.id === r![1] && x.patient_id === u.id);
    if (!d) throw new Http(404, "not_found");
    if (method === "DELETE") {
      state.documents = state.documents.filter((x) => x !== d);
      return {};
    }
    return { id: d.id, mime: d.mime, original_name: d.original_name, status: d.status, extraction: d.extraction, medicine_checks: d.medicine_checks };
  }
  if ((r = m(/^\/api\/documents\/([^/]+)\/retry$/))) {
    need("patient");
    const d = state.documents.find((x) => x.id === r![1]);
    if (d) (d.status = "needs_review"), (d.error = null);
    return {};
  }
  if ((r = m(/^\/api\/documents\/([^/]+)\/confirm$/))) {
    const u = need("patient");
    const d = state.documents.find((x) => x.id === r![1] && x.patient_id === u.id);
    if (!d) throw new Http(404, "not_found");
    const x = b as Extraction & { acknowledge_unverified_medicines?: boolean };
    if (!x.investigation_date || !x.title) throw new Http(400, "invalid_input");
    const checks = checkMedicines(x.medicines);
    const unverified = checks.filter((c) => c.status !== "matched");
    if (unverified.length && !x.acknowledge_unverified_medicines) throw new Http(409, "unverified_medicines", "Some medicine names are not in the register. Check them and confirm.", unverified);
    confirmRecord(u.id, d, x);
    return {};
  }
  if (p === "/api/records") return patientRecords(need("patient").id);
  if (p === "/api/trends") return trends(need("patient").id);
  if (p === "/api/patient/approval-pin") {
    const u = need("patient");
    if (!/^\d{6}$/.test(b.pin)) throw new Http(400, "invalid_input");
    u.pin = b.pin;
    return {};
  }
  if (p === "/api/mail-sources" && method === "GET") return state.mail_sources.filter((s) => s.patient_id === me()?.id).map(({ patient_id: _p, ...s }) => s);
  if (p === "/api/mail-sources" && method === "POST") {
    const u = need("patient");
    state.mail_sources.push({ id: uid(), patient_id: u.id, imap_host: b.imap_host, username: b.username, sender_patterns: ["synevo.md"], last_polled_at: null, last_error: null });
    return {};
  }
  if ((r = m(/^\/api\/mail-sources\/([^/]+)\/poll$/))) {
    const u = need("patient");
    const s = state.mail_sources.find((x) => x.id === r![1]);
    if (!s) throw new Http(404, "not_found");
    s.last_polled_at = now();
    // The demo "mailbox" always holds one new Synevo result.
    const date = new Date().toISOString().slice(0, 10);
    const x = labSample(date, [["Hemoglobina", 13.4, "g/dL", 12, 15.5], ["Glucoza", 5.6, "mmol/L", 3.9, 5.8], ["Colesterol total", 4.9, "mmol/L", 0, 5.2], ["TSH", 1.9, "mIU/L", 0.4, 4.0]]);
    x.title = "Analize de sânge (from Synevo email)";
    state.documents.push({ id: uid(), patient_id: u.id, original_name: `Synevo_rezultate_${date}.jpg`, mime: "image/jpeg", status: "needs_review", error: null, source: "email", email_from: "rezultate@synevo.md", created_at: now(), extraction: x, medicine_checks: [], data: scanImage(["Synevo Moldova", `Data: ${date}`, "", ...x.transcription.split("\n")], "BULETIN DE ANALIZE") });
    return { imported: 1 };
  }
  if ((r = m(/^\/api\/mail-sources\/([^/]+)$/)) && method === "DELETE") {
    state.mail_sources = state.mail_sources.filter((x) => x.id !== r![1]);
    return {};
  }
  if (p === "/api/share-tokens") {
    const u = need("patient");
    if (!u.pin) throw new Http(400, "pin_not_set");
    const code = Array.from({ length: 8 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
    const token = uid().replace(/-/g, "");
    const expires_at = plusMin(15);
    state.share_tokens.push({ patient_id: u.id, token, code, expires_at, used: false });
    const url = `${location.origin}${location.pathname}#/doctor/request?t=${token}`;
    return { url, short_code: `${code.slice(0, 4)}-${code.slice(4)}`, expires_at, qr_svg: await QRCode.toString(url, { type: "svg", margin: 1 }) };
  }
  if (p === "/api/access/requests") {
    const u = need("patient");
    return state.access_requests.filter((x) => x.patient_id === u.id).sort((a, b) => b.created_at.localeCompare(a.created_at)).map((x) => ({ ...x, ...withDoctor(x.doctor_id) }));
  }
  if (p === "/api/access/grants") {
    const u = need("patient");
    return state.grants.filter((g) => g.patient_id === u.id).map((g) => ({ id: g.id, scope: g.scope, expires_at: g.expires_at, active: !g.revoked && g.expires_at > now(), ...withDoctor(g.doctor_id) }));
  }
  if (p === "/api/access/log") {
    const u = need("patient");
    return state.audit.filter((a) => a.patient_id === u.id).sort((a, b) => b.at.localeCompare(a.at)).map((a) => ({ action: a.action, at: a.at, detail: a.detail, ...(a.doctor_id ? withDoctor(a.doctor_id) : { first_name: null, last_name: null }) }));
  }
  if ((r = m(/^\/api\/access\/requests\/([^/]+)\/(approve|deny)$/))) {
    const u = need("patient");
    const req = state.access_requests.find((x) => x.id === r![1] && x.patient_id === u.id && x.status === "pending");
    if (!req) throw new Http(404, "not_found", "This request is no longer pending.");
    if (r[2] === "deny") {
      req.status = "denied";
      state.audit.push({ patient_id: u.id, doctor_id: req.doctor_id, action: "access.denied", at: now(), detail: {} });
      return {};
    }
    if (!u.pin) throw new Http(400, "pin_not_set");
    if (b.pin !== u.pin) {
      state.audit.push({ patient_id: u.id, doctor_id: req.doctor_id, action: "access.pin_failed", at: now(), detail: {} });
      throw new Http(403, "wrong_pin");
    }
    req.status = "approved";
    state.grants.push({ id: uid(), patient_id: u.id, doctor_id: req.doctor_id, scope: req.scope, expires_at: new Date(Date.now() + req.duration_hours * 3600_000).toISOString(), revoked: false, created_at: now() });
    state.audit.push({ patient_id: u.id, doctor_id: req.doctor_id, action: "access.approved", at: now(), detail: { what: req.scope } });
    return {};
  }
  if ((r = m(/^\/api\/access\/grants\/([^/]+)$/)) && method === "DELETE") {
    const u = need("patient");
    const g = state.grants.find((x) => x.id === r![1] && x.patient_id === u.id);
    if (g) {
      g.revoked = true;
      state.audit.push({ patient_id: u.id, doctor_id: g.doctor_id, action: "access.revoked", at: now(), detail: {} });
    }
    return {};
  }

  // ----- doctor -----
  if (p === "/api/doctor/me") {
    const u = need("doctor");
    const d = u.doctor!;
    return { status: d.status, license_number: d.license_number, specialty: d.specialty, institution: d.institution, review_note: d.review_note };
  }
  if (p === "/api/doctor/certification") {
    const u = need("doctor");
    const form = body as FormData;
    const f = form.get("license") as File | null;
    u.doctor = { ...u.doctor!, status: "pending", license_number: String(form.get("license_number") ?? ""), specialty: String(form.get("specialty") ?? ""), institution: String(form.get("institution") ?? ""), review_note: null, license_data: f && f.size ? await fileToDataUrl(f) : null, submitted_at: now() };
    toast("Demo: an administrator now has to approve this licence. Use the Demo panel → Admin to do it yourself.", 15000);
    return {};
  }
  if (p === "/api/doctor/patients") {
    const u = need("doctor");
    return state.grants
      .filter((g) => g.doctor_id === u.id && !g.revoked && g.expires_at > now())
      .map((g) => {
        const pt = state.users.find((x) => x.id === g.patient_id)!;
        return { grant_id: g.id, patient_id: g.patient_id, scope: g.scope, expires_at: g.expires_at, first_name: pt.first_name ?? "Patient", last_name: pt.last_name ?? (pt.email ?? pt.phone ?? ""), birth_date: pt.birth_date };
      });
  }
  if (p === "/api/doctor/access-requests" && method === "GET") {
    const u = need("doctor");
    return state.access_requests
      .filter((x) => x.doctor_id === u.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((x) => {
        const pt = state.users.find((y) => y.id === x.patient_id)!;
        return { id: x.id, status: x.status, scope: x.scope, created_at: x.created_at, first_name: pt.first_name ?? "Patient", last_name: pt.last_name ?? (pt.email ?? pt.phone ?? "") };
      });
  }
  if (p === "/api/doctor/access-requests" && method === "POST") {
    const u = need("doctor");
    if (u.doctor!.status !== "certified") throw new Http(403, "doctor_not_certified");
    const code = String(b.short_code ?? "").replace(/\W/g, "").toUpperCase();
    const t = state.share_tokens.find((x) => !x.used && x.expires_at > now() && (b.token ? x.token === b.token : x.code === code));
    if (!t) throw new Http(404, "code_invalid_or_expired");
    t.used = true;
    const req = { id: uid(), patient_id: t.patient_id, doctor_id: u.id, scope: b.scope ?? "all", duration_hours: Number(b.duration_hours ?? 24), reason: b.reason ?? null, status: "pending", created_at: now(), expires_at: plusMin(30) };
    state.access_requests.push(req);
    state.audit.push({ patient_id: t.patient_id, doctor_id: u.id, action: "access.requested", at: now(), detail: { what: req.scope } });
    toast("Demo: the patient now sees this request under Doctors. Use the Demo panel → Patient to approve it with the PIN.", 15000);
    return { id: req.id };
  }
  if ((r = m(/^\/api\/doctor\/patients\/([^/]+)\/(records|trends)$/))) {
    const u = need("doctor");
    const g = activeGrant(u.id, r[1]);
    if (!g) throw new Http(403, "no_active_access");
    if (r[2] === "records") {
      state.audit.push({ patient_id: r[1], doctor_id: u.id, action: "access.viewed", at: now(), detail: { what: "records" } });
      return patientRecords(r[1], g.scope);
    }
    return g.scope === "prescriptions" ? [] : trends(r[1]);
  }

  // ----- admin -----
  if (p === "/api/admin/certifications") {
    need("admin");
    return state.users
      .filter((x) => x.doctor?.status === "pending")
      .map((x) => ({ id: x.id, idnp: x.idnp, first_name: x.first_name, last_name: x.last_name, email: x.email, license_number: x.doctor!.license_number, specialty: x.doctor!.specialty, institution: x.doctor!.institution, submitted_at: x.doctor!.submitted_at }));
  }
  if ((r = m(/^\/api\/admin\/certifications\/([^/]+)$/)) && method === "POST") {
    need("admin");
    const d = state.users.find((x) => x.id === r![1]);
    if (!d?.doctor) throw new Http(404, "not_found");
    d.doctor.status = b.decision === "certify" ? "certified" : "rejected";
    d.doctor.review_note = b.note ?? null;
    return {};
  }
  throw new Http(404, "not_found", `No demo handler for ${method} ${p}`);
}

// ---------- public surface used by the demo UI ----------

export const demo = {
  originalUrl: (id: string) => state.documents.find((d) => d.id === id)?.data ?? "",
  licenseUrl: (userId: string) => state.users.find((u) => u.id === userId)?.doctor?.license_data ?? "",
  current: () => me(),
  /** The stand-in MPass page calls this. */
  mpassSignIn(id: { idnp: string; firstName?: string; lastName?: string; email?: string }) {
    let u = state.users.find((x) => x.idnp === id.idnp);
    if (!u) {
      u = { id: uid(), role: "doctor", email: id.email || null, phone: null, first_name: id.firstName || null, last_name: id.lastName || null, idnp: id.idnp, birth_date: null, pin: null, doctor: { status: "unverified", license_number: null, specialty: null, institution: null, review_note: null, license_data: null, submitted_at: null } };
      state.users.push(u);
    }
    state.session = u.id;
    save();
  },
  /** Demo panel shortcuts: jump between the three kinds of user in one browser. */
  switchTo(role: Role) {
    let u = state.users.find((x) => x.role === role);
    if (!u) {
      if (role === "patient") {
        u = { id: uid(), role, email: "ana.popescu@example.com", phone: null, first_name: "Ana", last_name: "Popescu", idnp: null, birth_date: "1986-04-22", pin: "123456", doctor: null };
        state.users.push(u);
        seedPatient(u);
        toast("Signed in as patient Ana Popescu (demo). Her approval PIN is 123456.", 10000);
      } else if (role === "doctor") {
        u = { id: uid(), role, email: "elena.rusu@example.com", phone: null, first_name: "Elena", last_name: "Rusu", idnp: "2001234567890", birth_date: null, pin: null, doctor: { status: "unverified", license_number: null, specialty: null, institution: null, review_note: null, license_data: null, submitted_at: null } };
        state.users.push(u);
      } else {
        u = { id: uid(), role, email: "admin@meddata.local", phone: null, first_name: "MedData", last_name: "Admin", idnp: null, birth_date: null, pin: null, doctor: null };
        state.users.push(u);
      }
    }
    state.session = u.id;
    save();
  },
  reset() {
    localStorage.removeItem(KEY);
    state = fresh();
  },
  pdfRecords(base: string, date: string) {
    // base is /api/records/dates or /api/doctor/patients/:pid/records/dates
    const u = me();
    if (!u) return null;
    const pm = base.match(/^\/api\/doctor\/patients\/([^/]+)/);
    const pid = pm ? pm[1] : u.id;
    const scope = pm ? activeGrant(u.id, pid)?.scope ?? "none" : "all";
    if (scope === "none") return null;
    const rows = state.records.filter((r) => r.patient_id === pid && r.investigation_date === date && (scope === "all" || (scope === "labs" ? r.kind === "lab_result" : r.kind === "prescription")));
    const pt = state.users.find((x) => x.id === pid)!;
    return {
      who: [pt.first_name, pt.last_name].filter(Boolean).join(" "),
      records: rows.map((r) => ({ ...r, labs: state.labs.filter((l) => l.record_id === r.id), original: state.documents.find((d) => d.id === r.document_id) })),
    };
  },
};

export function installDemo() {
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!/^(\/|[a-z]+:\/\/[^/]+\/)api\//.test(url) || !url.includes("/api/")) return real(input, init);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = init?.body;
    if (typeof body === "string") body = JSON.parse(body);
    await new Promise((r) => setTimeout(r, 120));
    try {
      const out = await handle(method, url, body);
      save();
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    } catch (e) {
      save();
      if (e instanceof Http) return new Response(JSON.stringify({ error: e.code, message: e.msg, details: e.details }), { status: e.status, headers: { "content-type": "application/json" } });
      console.error(e);
      return new Response(JSON.stringify({ error: "demo_error", message: (e as Error).message }), { status: 500, headers: { "content-type": "application/json" } });
    }
  };
}
