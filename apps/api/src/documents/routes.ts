import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, type Ctx } from "../context.js";
import { many, one } from "../db.js";
import { audit } from "../audit.js";
import { requireRole } from "../auth/session.js";
import { readMultipart } from "../multipart.js";
import { ConfirmBody, confirmDocument, labSeries, listRecords, processDocument, storeOriginal } from "./service.js";
import { buildDatePdf } from "./pdf.js";

const Id = z.object({ id: z.string().uuid() });
const DateParam = z.object({ date: z.string().date() });

export function documentRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, storage } = ctx;
  const patient = { preHandler: requireRole("patient") };
  const kick = (id: string) => processDocument(ctx, id).catch((e) => app.log.error({ err: e, document_id: id }, "extraction failed"));

  app.post("/api/documents", patient, async (req) => {
    const { files } = await readMultipart(req);
    if (!files.length) throw new HttpError(400, "no_files");
    const wait = (req.query as { wait?: string }).wait === "true";
    const out = [];
    for (const f of files) {
      const stored = await storeOriginal(ctx, req.user!.id, { buffer: f.buffer, filename: f.filename, source: "upload" });
      if (!stored.duplicate) wait ? await processDocument(ctx, stored.id) : void kick(stored.id);
      out.push(stored);
    }
    return { documents: out };
  });

  app.get("/api/documents", patient, async (req) => {
    const { status } = z.object({ status: z.string().optional() }).parse(req.query);
    return many(
      db,
      `SELECT id, source, original_name, mime, size_bytes, status, error, email_from, created_at,
              extraction->>'title' AS title, extraction->>'investigation_date' AS investigation_date
         FROM documents WHERE patient_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC`,
      [req.user!.id, status ?? null],
    );
  });

  app.get("/api/documents/:id", patient, async (req) => {
    const { id } = Id.parse(req.params);
    const d = await one(db, "SELECT id, source, original_name, mime, status, error, extraction, medicine_checks, email_from, created_at FROM documents WHERE id = $1 AND patient_id = $2", [id, req.user!.id]);
    if (!d) throw new HttpError(404, "not_found");
    return d;
  });

  app.get("/api/documents/:id/original", patient, async (req, reply) => {
    const { id } = Id.parse(req.params);
    const d = await one<{ storage_key: string; mime: string; original_name: string }>(db, "SELECT storage_key, mime, original_name FROM documents WHERE id = $1 AND patient_id = $2", [id, req.user!.id]);
    if (!d) throw new HttpError(404, "not_found");
    return reply
      .type(d.mime)
      .header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(d.original_name)}`)
      .send(await storage.get(d.storage_key));
  });

  app.post("/api/documents/:id/retry", patient, async (req) => {
    const { id } = Id.parse(req.params);
    const d = await one(db, "SELECT id FROM documents WHERE id = $1 AND patient_id = $2 AND status IN ('failed', 'needs_review')", [id, req.user!.id]);
    if (!d) throw new HttpError(404, "not_found");
    await processDocument(ctx, id);
    return one(db, "SELECT id, status, error FROM documents WHERE id = $1", [id]);
  });

  app.post("/api/documents/:id/confirm", patient, async (req) => confirmDocument(ctx, req.user!.id, Id.parse(req.params).id, ConfirmBody.parse(req.body)));

  app.delete("/api/documents/:id", patient, async (req) => {
    const { id } = Id.parse(req.params);
    const r = await db.query("DELETE FROM documents WHERE id = $1 AND patient_id = $2", [id, req.user!.id]);
    if (!r.rowCount) throw new HttpError(404, "not_found");
    await audit(db, req.user!.id, req.user!.id, "document.deleted", { document_id: id });
    return { ok: true };
  });

  app.get("/api/records", patient, async (req) => listRecords(ctx, req.user!.id));
  app.get("/api/trends", patient, async (req) => labSeries(ctx, req.user!.id));

  app.get("/api/records/dates/:date/pdf", patient, async (req, reply) => {
    const { date } = DateParam.parse(req.params);
    const pdf = await buildDatePdf(ctx, req.user!.id, date);
    if (!pdf) throw new HttpError(404, "no_records_on_date");
    return reply.type("application/pdf").header("content-disposition", `attachment; filename="meddata-${date}.pdf"`).send(pdf);
  });
}
