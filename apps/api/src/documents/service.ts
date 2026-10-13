import { PDFDocument } from "pdf-lib";
import type { Ctx } from "../context.js";
import { HttpError } from "../context.js";
import { many, one, tx } from "../db.js";
import { sha256 } from "../crypto.js";
import { sniffMime } from "../multipart.js";
import { audit } from "../audit.js";
import { checkMedicines } from "../medicines/register.js";
import { ExtractionError } from "./extract.js";
import { Extraction } from "./schema.js";
import { z } from "zod";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const CLAUDE_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface IncomingFile {
  buffer: Buffer;
  filename: string;
  source: "upload" | "email";
  emailMessageId?: string;
  emailFrom?: string;
}

/** Stores the original (encrypted, never modified) and creates a document row. Duplicate files are returned, not re-stored. */
export async function storeOriginal(ctx: Ctx, patientId: string, f: IncomingFile): Promise<{ id: string; duplicate: boolean }> {
  if (f.buffer.length > MAX_FILE_BYTES) throw new HttpError(413, "file_too_large");
  const mime = sniffMime(f.buffer);
  if (!mime) throw new HttpError(415, "unsupported_file_type", "Upload a PDF, JPEG, PNG or WebP file.");
  if (mime === "image/heic") throw new HttpError(415, "heic_not_supported", "Convert HEIC photos to JPEG before uploading.");
  const hash = sha256(f.buffer);
  const existing = await one<{ id: string }>(ctx.db, "SELECT id FROM documents WHERE patient_id = $1 AND sha256 = $2", [patientId, hash]);
  if (existing) return { id: existing.id, duplicate: true };

  const key = await ctx.storage.put(f.buffer, `originals/${patientId}`);
  const row = await one<{ id: string }>(
    ctx.db,
    `INSERT INTO documents(patient_id, source, original_name, mime, size_bytes, sha256, storage_key, email_message_id, email_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [patientId, f.source, f.filename.slice(0, 255), mime, f.buffer.length, hash, key, f.emailMessageId ?? null, f.emailFrom ?? null],
  );
  await audit(ctx.db, f.source === "upload" ? patientId : null, patientId, "document.stored", { document_id: row!.id, source: f.source });
  return { id: row!.id, duplicate: false };
}

async function isEncryptedPdf(buf: Buffer): Promise<boolean> {
  try {
    await PDFDocument.load(buf);
    return false;
  } catch (e) {
    return /encrypt/i.test(String((e as Error).message));
  }
}

/** Reads the document with Claude and leaves it waiting for the patient's review. Nothing becomes a record until confirmed. */
export async function processDocument(ctx: Ctx, documentId: string): Promise<void> {
  const doc = await one<{ storage_key: string; mime: string; status: string }>(
    ctx.db,
    "UPDATE documents SET status = 'extracting', error = NULL WHERE id = $1 AND status IN ('uploaded', 'failed', 'needs_review') RETURNING storage_key, mime, status",
    [documentId],
  );
  if (!doc) return;
  const fail = (error: string) => ctx.db.query("UPDATE documents SET status = 'failed', error = $2 WHERE id = $1", [documentId, error]);
  try {
    const buffer = await ctx.storage.get(doc.storage_key);
    if (doc.mime === "application/pdf" && (await isEncryptedPdf(buffer))) return void (await fail("password_protected"));
    if (doc.mime !== "application/pdf" && buffer.length > CLAUDE_MAX_IMAGE_BYTES) return void (await fail("image_too_large"));
    const extraction = await ctx.extractor.extract({ buffer, mime: doc.mime });
    const checks = await checkMedicines(ctx.db, extraction.medicines);
    await ctx.db.query("UPDATE documents SET status = 'needs_review', extraction = $2, medicine_checks = $3 WHERE id = $1", [
      documentId,
      extraction,
      JSON.stringify(checks),
    ]);
  } catch (e) {
    await fail(e instanceof ExtractionError ? e.code : "extraction_failed");
    if (!(e instanceof ExtractionError)) throw e;
  }
}

export const ConfirmBody = Extraction.extend({
  investigation_date: z.string().date(),
  acknowledge_unverified_medicines: z.boolean().default(false),
});

/** The patient's review step: their corrected version becomes the record. */
export async function confirmDocument(ctx: Ctx, patientId: string, documentId: string, body: z.infer<typeof ConfirmBody>) {
  const doc = await one<{ status: string }>(ctx.db, "SELECT status FROM documents WHERE id = $1 AND patient_id = $2", [documentId, patientId]);
  if (!doc) throw new HttpError(404, "not_found");
  if (doc.status !== "needs_review" && doc.status !== "failed") throw new HttpError(409, "not_reviewable");

  const checks = await checkMedicines(ctx.db, body.medicines);
  const unverified = checks.filter((c) => c.status === "similar" || c.status === "not_found");
  if (unverified.length && !body.acknowledge_unverified_medicines)
    throw Object.assign(new HttpError(409, "unverified_medicines", "Some medicine names are not in the register. Check them and confirm."), {
      details: unverified,
    });

  return tx(ctx.db, async (c) => {
    const rec = await one<{ id: string }>(
      c,
      `INSERT INTO records(patient_id, document_id, kind, investigation_date, institution, doctor_name, title, summary, transcription, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        patientId,
        documentId,
        body.document_kind,
        body.investigation_date,
        body.institution,
        body.doctor_name,
        body.title,
        body.summary,
        body.transcription,
        { diagnoses: body.diagnoses, medicines: body.medicines, medicine_checks: checks, uncertain_fields: body.uncertain_fields },
      ],
    );
    for (const v of body.lab_values) {
      await c.query(
        `INSERT INTO lab_values(record_id, patient_id, test_name, value, value_text, unit, ref_low, ref_high, investigation_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [rec!.id, patientId, v.test, v.value, v.value_text, v.unit, v.ref_low, v.ref_high, body.investigation_date],
      );
    }
    await c.query("UPDATE documents SET status = 'confirmed', extraction = $2, medicine_checks = $3 WHERE id = $1", [documentId, body, JSON.stringify(checks)]);
    await audit(c, patientId, patientId, "record.confirmed", { document_id: documentId, record_id: rec!.id });
    return { record_id: rec!.id, medicine_checks: checks };
  });
}

export type Scope = "all" | "labs" | "prescriptions";
const scopeKinds = (scope: Scope) => (scope === "labs" ? ["lab_result"] : scope === "prescriptions" ? ["prescription"] : null);

export async function listRecords(ctx: Ctx, patientId: string, scope: Scope = "all") {
  const kinds = scopeKinds(scope);
  return many(
    ctx.db,
    `SELECT r.id, r.document_id, r.kind, to_char(r.investigation_date, 'YYYY-MM-DD') AS investigation_date, r.institution,
            r.doctor_name, r.title, r.summary, r.transcription, r.data, d.original_name, d.mime, d.source
       FROM records r JOIN documents d ON d.id = r.document_id
      WHERE r.patient_id = $1 AND ($2::text[] IS NULL OR r.kind = ANY($2))
      ORDER BY r.investigation_date DESC, r.confirmed_at DESC`,
    [patientId, kinds],
  );
}

export async function labSeries(ctx: Ctx, patientId: string) {
  const rows = await many<{ test_name: string; value: string | null; value_text: string; unit: string | null; ref_low: string | null; ref_high: string | null; date: string }>(
    ctx.db,
    `SELECT test_name, value, value_text, unit, ref_low, ref_high, to_char(investigation_date, 'YYYY-MM-DD') AS date
       FROM lab_values WHERE patient_id = $1 ORDER BY lower(test_name), investigation_date`,
    [patientId],
  );
  const series = new Map<string, { test: string; unit: string | null; points: object[] }>();
  for (const r of rows) {
    const k = r.test_name.trim().toLowerCase();
    if (!series.has(k)) series.set(k, { test: r.test_name, unit: r.unit, points: [] });
    const num = (x: string | null) => (x == null ? null : Number(x));
    series.get(k)!.points.push({ date: r.date, value: num(r.value), value_text: r.value_text, ref_low: num(r.ref_low), ref_high: num(r.ref_high) });
  }
  return [...series.values()];
}
