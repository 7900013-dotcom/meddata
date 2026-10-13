import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { multipartBody, png, sampleExtraction, setup, signInPatient, type TestEnv } from "./helpers.js";
import { normalizeMedicineName } from "../src/medicines/register.js";

let env: TestEnv;
let cookie: string;
beforeAll(async () => {
  env = await setup();
  cookie = await signInPatient(env, "docs@example.com");
});
afterAll(() => env.close());

async function upload(data: Buffer, filename = "scan.png", type = "image/png") {
  const body = multipartBody([{ name: "file", filename, type, data }]);
  return env.app.inject({ method: "POST", url: "/api/documents?wait=true", headers: { cookie, ...body.headers }, payload: body.payload });
}

describe("uploads, reading, review and dated PDFs", () => {
  it("keeps the original byte-for-byte, encrypted at rest", async () => {
    const original = png(8, 8);
    const id = (await upload(original)).json().documents[0].id;
    const back = await env.app.inject({ method: "GET", url: `/api/documents/${id}/original`, headers: { cookie } });
    expect(Buffer.compare(back.rawPayload, original)).toBe(0);
    const { storage_key } = (await env.ctx.db.query("SELECT storage_key FROM documents WHERE id = $1", [id])).rows[0];
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(`${env.ctx.cfg.STORAGE_DIR}/${storage_key}`).includes(original.subarray(16))).toBe(false);
  });

  it("does not store the same file twice", async () => {
    const data = png(9, 9);
    const a = (await upload(data)).json().documents[0];
    const b = (await upload(data)).json().documents[0];
    expect(b).toEqual({ id: a.id, duplicate: true });
  });

  it("rejects files that aren't PDFs or images, whatever their name says", async () => {
    const r = await upload(Buffer.from("MZ not a pdf"), "fake.pdf", "application/pdf");
    expect(r.json().error).toBe("unsupported_file_type");
  });

  it("creates nothing until the patient confirms, then builds a PDF for that date", async () => {
    env.extractor.next = sampleExtraction();
    const id = (await upload(png(10, 10))).json().documents[0].id;
    const doc = (await env.app.inject({ method: "GET", url: `/api/documents/${id}`, headers: { cookie } })).json();
    expect(doc.status).toBe("needs_review");
    expect((await env.app.inject({ method: "GET", url: "/api/records", headers: { cookie } })).json()).toHaveLength(0);

    // The patient corrects a value during review.
    const edited = { ...doc.extraction, lab_values: [{ ...doc.extraction.lab_values[0], value: 11.4, value_text: "11.4" }] };
    const conf = await env.app.inject({ method: "POST", url: `/api/documents/${id}/confirm`, headers: { cookie }, payload: edited });
    expect(conf.statusCode).toBe(200);

    const records = (await env.app.inject({ method: "GET", url: "/api/records", headers: { cookie } })).json();
    expect(records[0]).toMatchObject({ investigation_date: "2026-09-14", title: "Hemoleucogramă completă" });
    const trends = (await env.app.inject({ method: "GET", url: "/api/trends", headers: { cookie } })).json();
    expect(trends[0].points[0]).toMatchObject({ value: 11.4, ref_low: 12 });

    const pdf = await env.app.inject({ method: "GET", url: "/api/records/dates/2026-09-14/pdf", headers: { cookie } });
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    const parsed = await PDFDocument.load(pdf.rawPayload);
    expect(parsed.getPageCount()).toBe(2); // transcription page + original
    const none = await env.app.inject({ method: "GET", url: "/api/records/dates/2020-01-01/pdf", headers: { cookie } });
    expect(none.statusCode).toBe(404);
  });

  it("asks the patient to confirm medicine names that aren't in the register", async () => {
    await env.ctx.db.query("INSERT INTO medicines(name, inn, normalized) VALUES ('Amoxicilină', 'amoxicillinum', 'amoxicilina'), ('Paracetamol', 'paracetamolum', 'paracetamol')");
    env.extractor.next = sampleExtraction({
      document_kind: "prescription",
      investigation_date: "2026-10-01",
      lab_values: [],
      medicines: [
        { name: "Amoxicilină 500mg", dose: "500 mg", frequency: "3/zi", duration: "7 zile", route: null, notes: null, uncertain: false },
        { name: "Paracetamoi", dose: null, frequency: null, duration: null, route: null, notes: null, uncertain: true },
      ],
    });
    const id = (await upload(png(11, 11))).json().documents[0].id;
    const doc = (await env.app.inject({ method: "GET", url: `/api/documents/${id}`, headers: { cookie } })).json();
    expect(doc.medicine_checks.map((c: { status: string }) => c.status)).toEqual(["matched", "similar"]);
    expect(doc.medicine_checks[1].suggestions).toContain("Paracetamol");

    const blocked = await env.app.inject({ method: "POST", url: `/api/documents/${id}/confirm`, headers: { cookie }, payload: doc.extraction });
    expect(blocked.json().error).toBe("unverified_medicines");
    const ok = await env.app.inject({
      method: "POST",
      url: `/api/documents/${id}/confirm`,
      headers: { cookie },
      payload: { ...doc.extraction, acknowledge_unverified_medicines: true },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("normalizes medicine names for matching", () => {
    expect(normalizeMedicineName("Amoxicilină 500mg")).toBe("amoxicilina");
    expect(normalizeMedicineName("Ibupro[?]en, 200 mg")).toBe("ibuproen");
  });

  it("does not let one patient read another's documents", async () => {
    const other = await signInPatient(env, "other@example.com");
    const [doc] = (await env.app.inject({ method: "GET", url: "/api/documents", headers: { cookie } })).json();
    const r = await env.app.inject({ method: "GET", url: `/api/documents/${doc.id}/original`, headers: { cookie: other } });
    expect(r.statusCode).toBe(404);
  });
});
