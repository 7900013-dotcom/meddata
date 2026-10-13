export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.ok) return (res.headers.get("content-type")?.includes("json") ? res.json() : (res as unknown)) as Promise<T>;
  const body = await res.json().catch(() => ({}));
  throw new ApiError(res.status, body.error ?? "error", body.message ?? MESSAGES[body.error] ?? "Something went wrong.", body.details);
}

const MESSAGES: Record<string, string> = {
  wrong_code: "That code is not right. Check the latest message and try again.",
  code_expired: "The code expired. Ask for a new one.",
  too_many_codes: "Too many codes requested. Wait an hour and try again.",
  doctors_use_mpass: "Doctors sign in with MPass.",
  wrong_pin: "Wrong PIN.",
  pin_not_set: "Set an approval PIN in Settings first.",
  doctor_not_certified: "Your certification has not been approved yet.",
  code_invalid_or_expired: "This code is invalid, expired, or already used. Ask the patient for a new one.",
  no_active_access: "Your access to this patient has ended.",
  invalid_input: "Some fields are not valid.",
};

export const api = {
  get: <T>(url: string) => fetch(url, { credentials: "include" }).then((r) => handle<T>(r)),
  send: <T>(method: string, url: string, body?: unknown) =>
    fetch(url, {
      method,
      credentials: "include",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then((r) => handle<T>(r)),
  upload: <T>(url: string, form: FormData) => fetch(url, { method: "POST", credentials: "include", body: form }).then((r) => handle<T>(r)),
};

export interface Me {
  id: string;
  role: "patient" | "doctor" | "admin";
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  has_pin: boolean;
  doctor_status: "unverified" | "pending" | "certified" | "rejected" | "suspended" | null;
}

export interface Medicine {
  name: string;
  dose: string | null;
  frequency: string | null;
  duration: string | null;
  route: string | null;
  notes: string | null;
  uncertain: boolean;
}
export interface LabValue {
  test: string;
  value: number | null;
  value_text: string;
  unit: string | null;
  ref_low: number | null;
  ref_high: number | null;
  uncertain: boolean;
}
export interface Extraction {
  document_kind: string;
  investigation_date: string | null;
  institution: string | null;
  doctor_name: string | null;
  title: string;
  summary: string;
  transcription: string;
  diagnoses: string[];
  medicines: Medicine[];
  lab_values: LabValue[];
  uncertain_fields: string[];
}
export interface RecordRow {
  id: string;
  document_id: string;
  kind: string;
  investigation_date: string;
  institution: string | null;
  doctor_name: string | null;
  title: string;
  summary: string | null;
  data: { medicines?: Medicine[]; diagnoses?: string[] };
  original_name: string;
  source: "upload" | "email";
}
export interface Series {
  test: string;
  unit: string | null;
  points: { date: string; value: number | null; value_text: string; ref_low: number | null; ref_high: number | null }[];
}

export const KIND_LABEL: Record<string, string> = {
  lab_result: "Lab result",
  prescription: "Prescription",
  discharge_summary: "Discharge summary",
  consultation: "Consultation",
  imaging: "Imaging",
  other: "Other",
};

export const fmtDate = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
export const fmtDateTime = (d: string) => new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
export const fullName = (p: { first_name: string | null; last_name: string | null }) => [p.first_name, p.last_name].filter(Boolean).join(" ") || "Unnamed";
