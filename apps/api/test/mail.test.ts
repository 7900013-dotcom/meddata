import { afterAll, beforeAll, describe, expect, it } from "vitest";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { PDFDocument } from "pdf-lib";
import { setup, signInPatient, type TestEnv } from "./helpers.js";
import { ingestEmail, KNOWN_LABS, senderMatches } from "../src/mail/ingest.js";

let env: TestEnv;
let patientId: string;
beforeAll(async () => {
  env = await setup();
  const cookie = await signInPatient(env, "lab@example.com");
  patientId = (await env.app.inject({ method: "GET", url: "/api/me", headers: { cookie } })).json().user.id;
});
afterAll(() => env.close());

async function eml(from: string, attachments: { filename: string; content: Buffer }[]) {
  return new MailComposer({ from, to: "lab@example.com", subject: "Rezultatele analizelor", text: "Vă transmitem rezultatele.", attachments }).compile().build();
}

async function samplePdf() {
  const d = await PDFDocument.create();
  d.addPage();
  return Buffer.from(await d.save());
}

describe("lab results by email", () => {
  it("matches senders by domain or exact address", () => {
    expect(senderMatches(["rezultate@synevo.md"], KNOWN_LABS.synevo)).toBe(true);
    expect(senderMatches(["noreply@mail.synevo.md"], ["synevo.md"])).toBe(true);
    expect(senderMatches(["phish@synevo.md.evil.com"], ["synevo.md"])).toBe(false);
    expect(senderMatches(["a@lab.md"], ["results@lab.md"])).toBe(false);
  });

  it("imports PDF attachments from a lab and waits for review", async () => {
    const raw = await eml("Synevo <rezultate@synevo.md>", [{ filename: "rezultate.pdf", content: await samplePdf() }]);
    const r = await ingestEmail(env.ctx, patientId, raw, KNOWN_LABS.synevo);
    expect(r.matched).toBe(true);
    expect(r.documents).toHaveLength(1);
    const doc = (await env.ctx.db.query("SELECT source, status, email_from FROM documents WHERE id = $1", [r.documents[0].id])).rows[0];
    expect(doc).toEqual({ source: "email", status: "needs_review", email_from: "rezultate@synevo.md" });

    // Same email again: nothing new.
    const again = await ingestEmail(env.ctx, patientId, raw, KNOWN_LABS.synevo);
    expect(again.documents[0].duplicate).toBe(true);
  });

  it("ignores email from other senders", async () => {
    const raw = await eml("shop@example.com", [{ filename: "invoice.pdf", content: await samplePdf() }]);
    const r = await ingestEmail(env.ctx, patientId, raw, KNOWN_LABS.synevo);
    expect(r).toMatchObject({ matched: false, documents: [] });
  });

  it("notes lab emails without attachments (results behind a link)", async () => {
    const raw = await eml("rezultate@synevo.md", []);
    const r = await ingestEmail(env.ctx, patientId, raw, KNOWN_LABS.synevo);
    expect(r.note).toBe("no_attachments");
  });
});
