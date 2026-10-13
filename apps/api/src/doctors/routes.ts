import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, type Ctx } from "../context.js";
import { many, one } from "../db.js";
import { audit } from "../audit.js";
import { requireRole } from "../auth/session.js";
import { readMultipart, sniffMime } from "../multipart.js";

/**
 * Doctor certification. Signing in with MPass proves who the doctor is; this step
 * proves they are a practising doctor. Default: an admin reviews the uploaded
 * licence and confirms it against the official register by hand. Only certified
 * doctors can request access to patient records (enforced in access/routes.ts).
 */
export function doctorRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, storage } = ctx;

  app.get("/api/doctor/me", { preHandler: requireRole("doctor") }, async (req) =>
    one(
      db,
      `SELECT u.id, u.first_name, u.last_name, u.email, d.status, d.license_number, d.specialty, d.institution,
              d.submitted_at, d.reviewed_at, d.review_note
         FROM users u JOIN doctor_profiles d ON d.user_id = u.id WHERE u.id = $1`,
      [req.user!.id],
    ),
  );

  app.post("/api/doctor/certification", { preHandler: requireRole("doctor") }, async (req) => {
    const { fields, files } = await readMultipart(req);
    const f = z
      .object({
        license_number: z.string().trim().min(3).max(40),
        specialty: z.string().trim().min(2).max(120),
        institution: z.string().trim().min(2).max(200),
      })
      .parse(fields);
    const file = files[0];
    if (!file) throw new HttpError(400, "license_file_required");
    const mime = sniffMime(file.buffer);
    if (!mime || mime === "image/heic") throw new HttpError(415, "unsupported_file_type");

    const cur = await one<{ status: string }>(db, "SELECT status FROM doctor_profiles WHERE user_id = $1", [req.user!.id]);
    if (cur?.status === "certified") throw new HttpError(409, "already_certified");
    if (cur?.status === "suspended") throw new HttpError(403, "suspended");

    const key = await storage.put(file.buffer, `licenses/${req.user!.id}`);
    await db.query(
      `UPDATE doctor_profiles SET status = 'pending', license_number = $2, specialty = $3, institution = $4,
              license_file_key = $5, submitted_at = now(), reviewed_at = NULL, reviewed_by = NULL, review_note = NULL
        WHERE user_id = $1`,
      [req.user!.id, f.license_number, f.specialty, f.institution, key],
    );
    await audit(db, req.user!.id, null, "doctor.certification_submitted", { license_number: f.license_number });
    return { status: "pending" };
  });

  // ---- Admin review queue ----

  app.get("/api/admin/certifications", { preHandler: requireRole("admin") }, async (req) => {
    const { status } = z.object({ status: z.string().default("pending") }).parse(req.query);
    return many(
      db,
      `SELECT u.id, u.idnp, u.first_name, u.last_name, u.email, d.status, d.license_number, d.specialty, d.institution, d.submitted_at
         FROM users u JOIN doctor_profiles d ON d.user_id = u.id WHERE d.status = $1 ORDER BY d.submitted_at`,
      [status],
    );
  });

  app.get("/api/admin/certifications/:id/license", { preHandler: requireRole("admin") }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const d = await one<{ license_file_key: string | null }>(db, "SELECT license_file_key FROM doctor_profiles WHERE user_id = $1", [id]);
    if (!d?.license_file_key) throw new HttpError(404, "not_found");
    const buf = await storage.get(d.license_file_key);
    await audit(db, req.user!.id, null, "admin.license_viewed", { doctor_id: id });
    return reply.type(sniffMime(buf) ?? "application/octet-stream").send(buf);
  });

  app.post("/api/admin/certifications/:id", { preHandler: requireRole("admin") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ decision: z.enum(["certify", "reject", "suspend"]), note: z.string().max(500).optional() }).parse(req.body);
    const status = { certify: "certified", reject: "rejected", suspend: "suspended" }[b.decision];
    const r = await db.query(
      `UPDATE doctor_profiles SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4, verification_method = 'manual'
        WHERE user_id = $1 AND ($2 = 'suspended' OR status = 'pending')`,
      [id, status, req.user!.id, b.note ?? null],
    );
    if (r.rowCount === 0) throw new HttpError(409, "not_pending");
    // A suspended doctor loses every active grant at once.
    if (status === "suspended") await db.query("UPDATE access_grants SET revoked_at = now() WHERE doctor_id = $1 AND revoked_at IS NULL", [id]);
    await audit(db, req.user!.id, null, `admin.doctor_${status}`, { doctor_id: id, note: b.note });
    return { status };
  });
}
