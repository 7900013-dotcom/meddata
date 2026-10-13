import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, type Ctx } from "../context.js";
import { many, one } from "../db.js";
import { audit } from "../audit.js";
import { requireRole } from "../auth/session.js";
import { readMultipart } from "../multipart.js";
import { ingestEmail, KNOWN_LABS } from "./ingest.js";
import { pollMailSource } from "./imap.js";

export function mailRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, storage } = ctx;
  const patient = { preHandler: requireRole("patient") };

  app.get("/api/mail-sources", patient, async (req) =>
    many(
      db,
      `SELECT id, imap_host, imap_port, username, mailbox, sender_patterns, last_polled_at, last_error, enabled, created_at
         FROM mail_sources WHERE patient_id = $1 ORDER BY created_at`,
      [req.user!.id],
    ),
  );

  app.post("/api/mail-sources", patient, async (req) => {
    const b = z
      .object({
        imap_host: z.string().min(3),
        imap_port: z.number().int().default(993),
        username: z.string().min(3),
        password: z.string().min(1).describe("An app password, not the main account password"),
        mailbox: z.string().default("INBOX"),
        labs: z.array(z.enum(Object.keys(KNOWN_LABS) as [string, ...string[]])).default(["synevo"]),
        extra_senders: z.array(z.string().min(3)).default([]),
      })
      .parse(req.body);
    const patterns = [...b.labs.flatMap((l) => KNOWN_LABS[l]), ...b.extra_senders];
    const row = await one<{ id: string }>(
      db,
      `INSERT INTO mail_sources(patient_id, imap_host, imap_port, username, secret_enc, mailbox, sender_patterns)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [req.user!.id, b.imap_host, b.imap_port, b.username, storage.encryptSecret(b.password), b.mailbox, patterns],
    );
    await audit(db, req.user!.id, req.user!.id, "mail.source_added", { host: b.imap_host, senders: patterns });
    return { id: row!.id, sender_patterns: patterns };
  });

  app.delete("/api/mail-sources/:id", patient, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await db.query("DELETE FROM mail_sources WHERE id = $1 AND patient_id = $2", [id, req.user!.id]);
    if (!r.rowCount) throw new HttpError(404, "not_found");
    return { ok: true };
  });

  app.post("/api/mail-sources/:id/poll", patient, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const own = await one(db, "SELECT id FROM mail_sources WHERE id = $1 AND patient_id = $2", [id, req.user!.id]);
    if (!own) throw new HttpError(404, "not_found");
    return pollMailSource(ctx, id);
  });

  /** Manual fallback: the patient uploads a saved .eml from the lab. */
  app.post("/api/mail/import-eml", patient, async (req) => {
    const { files } = await readMultipart(req);
    if (!files[0]) throw new HttpError(400, "no_files");
    const patterns = Object.values(KNOWN_LABS).flat();
    const results = [];
    for (const f of files) results.push(await ingestEmail(ctx, req.user!.id, f.buffer, patterns));
    return results;
  });
}
