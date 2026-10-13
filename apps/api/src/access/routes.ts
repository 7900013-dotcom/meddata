import type { FastifyInstance } from "fastify";
import QRCode from "qrcode";
import { z } from "zod";
import { HttpError, type Ctx } from "../context.js";
import { many, one, tx } from "../db.js";
import { audit } from "../audit.js";
import { hmac, randomToken, sha256, shortCode, verifyPin } from "../crypto.js";
import { requireRole } from "../auth/session.js";
import { buildDatePdf } from "../documents/pdf.js";
import { labSeries, listRecords, type Scope } from "../documents/service.js";

const Id = z.object({ id: z.string().uuid() });
const MAX_PIN_FAILURES = 5;

/**
 * Doctor access works like a bank payment confirmation:
 * 1. The patient shows a QR code (or a short code) that is valid for a few minutes and can be used once.
 * 2. A certified doctor scans it and requests access with a scope and duration.
 * 3. The patient gets a notification and approves in the app with their PIN.
 * 4. The doctor sees only what the grant covers, until it expires or the patient revokes it. Every view is logged.
 */
export function accessRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, cfg, notifier } = ctx;
  const patient = { preHandler: requireRole("patient") };
  const doctor = { preHandler: requireRole("doctor") };
  const codeHash = (code: string) => hmac(cfg.SESSION_SECRET, `share:${code.toUpperCase().replace(/[^A-Z0-9]/g, "")}`);

  // ---------- Patient side ----------

  app.post("/api/share-tokens", patient, async (req) => {
    const token = randomToken();
    const code = shortCode(8);
    const row = await one<{ expires_at: string }>(
      db,
      `INSERT INTO share_tokens(patient_id, token_hash, short_code_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(mins => $4)) RETURNING expires_at`,
      [req.user!.id, sha256(token), codeHash(code), cfg.SHARE_TOKEN_TTL_MINUTES],
    );
    const url = `${cfg.PUBLIC_URL}/doctor/request?t=${token}`;
    return { url, short_code: `${code.slice(0, 4)}-${code.slice(4)}`, expires_at: row!.expires_at, qr_svg: await QRCode.toString(url, { type: "svg", margin: 1 }) };
  });

  app.get("/api/access/requests", patient, async (req) => {
    await expireStale();
    return many(
      db,
      `SELECT r.id, r.scope, r.duration_hours, r.reason, r.status, r.created_at, r.expires_at, r.decided_at,
              u.first_name, u.last_name, d.specialty, d.institution, d.license_number
         FROM access_requests r JOIN users u ON u.id = r.doctor_id JOIN doctor_profiles d ON d.user_id = r.doctor_id
        WHERE r.patient_id = $1 ORDER BY r.created_at DESC LIMIT 100`,
      [req.user!.id],
    );
  });

  app.post("/api/access/requests/:id/approve", patient, async (req) => {
    const { id } = Id.parse(req.params);
    const { pin } = z.object({ pin: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const pid = req.user!.id;
    const prof = await one<{ approval_pin_hash: string | null; pin_failures: number; locked: boolean }>(
      db,
      "SELECT approval_pin_hash, pin_failures, coalesce(pin_locked_until > now(), false) AS locked FROM patient_profiles WHERE user_id = $1",
      [pid],
    );
    if (!prof?.approval_pin_hash) throw new HttpError(409, "pin_not_set");
    if (prof.locked) throw new HttpError(423, "pin_locked", "Too many wrong PINs. Try again in 15 minutes.");
    if (!verifyPin(pin, prof.approval_pin_hash)) {
      const failures = prof.pin_failures + 1;
      await db.query(
        `UPDATE patient_profiles SET pin_failures = CASE WHEN $2::int >= $3::int THEN 0 ELSE $2::int END,
                pin_locked_until = CASE WHEN $2::int >= $3::int THEN now() + interval '15 minutes' END WHERE user_id = $1`,
        [pid, failures, MAX_PIN_FAILURES],
      );
      await audit(db, pid, pid, "access.pin_failed", { request_id: id });
      throw new HttpError(403, "wrong_pin");
    }
    await db.query("UPDATE patient_profiles SET pin_failures = 0, pin_locked_until = NULL WHERE user_id = $1", [pid]);

    return tx(db, async (c) => {
      const r = await one<{ doctor_id: string; scope: string; duration_hours: number }>(
        c,
        `UPDATE access_requests SET status = 'approved', decided_at = now()
          WHERE id = $1 AND patient_id = $2 AND status = 'pending' AND expires_at > now()
          RETURNING doctor_id, scope, duration_hours`,
        [id, pid],
      );
      if (!r) throw new HttpError(409, "request_not_pending");
      const doc = await one<{ status: string }>(c, "SELECT status FROM doctor_profiles WHERE user_id = $1", [r.doctor_id]);
      if (doc?.status !== "certified") throw new HttpError(409, "doctor_not_certified");
      const g = await one<{ id: string; expires_at: string }>(
        c,
        `INSERT INTO access_grants(request_id, doctor_id, patient_id, scope, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5)) RETURNING id, expires_at`,
        [id, r.doctor_id, pid, r.scope, r.duration_hours],
      );
      await audit(c, pid, pid, "access.approved", { request_id: id, grant_id: g!.id, doctor_id: r.doctor_id, scope: r.scope });
      return { grant_id: g!.id, expires_at: g!.expires_at };
    });
  });

  app.post("/api/access/requests/:id/deny", patient, async (req) => {
    const { id } = Id.parse(req.params);
    const r = await db.query("UPDATE access_requests SET status = 'denied', decided_at = now() WHERE id = $1 AND patient_id = $2 AND status = 'pending'", [id, req.user!.id]);
    if (!r.rowCount) throw new HttpError(409, "request_not_pending");
    await audit(db, req.user!.id, req.user!.id, "access.denied", { request_id: id });
    return { status: "denied" };
  });

  app.get("/api/access/grants", patient, async (req) =>
    many(
      db,
      `SELECT g.id, g.scope, g.expires_at, g.revoked_at, g.created_at, u.first_name, u.last_name, d.specialty, d.institution,
              (g.revoked_at IS NULL AND g.expires_at > now()) AS active
         FROM access_grants g JOIN users u ON u.id = g.doctor_id JOIN doctor_profiles d ON d.user_id = g.doctor_id
        WHERE g.patient_id = $1 ORDER BY g.created_at DESC`,
      [req.user!.id],
    ),
  );

  app.delete("/api/access/grants/:id", patient, async (req) => {
    const { id } = Id.parse(req.params);
    const r = await db.query("UPDATE access_grants SET revoked_at = now() WHERE id = $1 AND patient_id = $2 AND revoked_at IS NULL", [id, req.user!.id]);
    if (!r.rowCount) throw new HttpError(404, "not_found");
    await audit(db, req.user!.id, req.user!.id, "access.revoked", { grant_id: id });
    return { ok: true };
  });

  app.get("/api/access/log", patient, async (req) =>
    many(
      db,
      `SELECT a.action, a.detail, a.at, u.first_name, u.last_name, u.role
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.patient_id = $1 AND (a.action LIKE 'access.%' OR a.action LIKE 'doctor.%') ORDER BY a.at DESC LIMIT 200`,
      [req.user!.id],
    ),
  );

  // ---------- Doctor side ----------

  async function requireCertified(doctorId: string) {
    const d = await one<{ status: string }>(db, "SELECT status FROM doctor_profiles WHERE user_id = $1", [doctorId]);
    if (d?.status !== "certified") throw new HttpError(403, "doctor_not_certified", "Only certified doctors can request access.");
  }

  app.post("/api/doctor/access-requests", { ...doctor, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const b = z
      .object({
        token: z.string().optional(),
        short_code: z.string().optional(),
        scope: z.enum(["all", "labs", "prescriptions"]).default("all"),
        duration_hours: z.number().int().min(1).max(720).default(24),
        reason: z.string().max(300).optional(),
      })
      .refine((v) => v.token || v.short_code, "token or short_code is required")
      .parse(req.body);
    const did = req.user!.id;
    await requireCertified(did);

    const share = await one<{ id: string; patient_id: string }>(
      db,
      `UPDATE share_tokens SET used_at = now()
        WHERE id = (SELECT id FROM share_tokens WHERE ${b.token ? "token_hash" : "short_code_hash"} = $1
                      AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1)
        RETURNING id, patient_id`,
      [b.token ? sha256(b.token) : codeHash(b.short_code!)],
    );
    if (!share) {
      await audit(db, did, null, "doctor.share_code_invalid");
      throw new HttpError(404, "code_invalid_or_expired");
    }
    const r = await one<{ id: string; expires_at: string }>(
      db,
      `INSERT INTO access_requests(doctor_id, patient_id, scope, duration_hours, reason, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6)) RETURNING id, expires_at`,
      [did, share.patient_id, b.scope, b.duration_hours, b.reason ?? null, cfg.ACCESS_REQUEST_TTL_MINUTES],
    );
    await audit(db, did, share.patient_id, "access.requested", { request_id: r!.id, scope: b.scope, duration_hours: b.duration_hours });

    const p = await one<{ email: string | null; phone: string | null }>(db, "SELECT email, phone FROM users WHERE id = $1", [share.patient_id]);
    const dr = await one<{ first_name: string | null; last_name: string | null }>(db, "SELECT first_name, last_name FROM users WHERE id = $1", [did]);
    const msg = `Dr ${[dr?.first_name, dr?.last_name].filter(Boolean).join(" ")} asks to see your MedData records. Open the app to approve or deny: ${cfg.PUBLIC_URL}/sharing`;
    if (p?.phone) await notifier.sms(p.phone, msg).catch((e) => app.log.warn(e, "sms failed"));
    else if (p?.email) await notifier.email(p.email, "A doctor asks to see your records", msg).catch((e) => app.log.warn(e, "email failed"));
    return { request_id: r!.id, status: "pending", expires_at: r!.expires_at };
  });

  app.get("/api/doctor/access-requests", doctor, async (req) => {
    await expireStale();
    return many(
      db,
      `SELECT r.id, r.scope, r.duration_hours, r.status, r.created_at, r.expires_at, r.decided_at,
              u.first_name, u.last_name, g.id AS grant_id
         FROM access_requests r JOIN users u ON u.id = r.patient_id LEFT JOIN access_grants g ON g.request_id = r.id
        WHERE r.doctor_id = $1 ORDER BY r.created_at DESC LIMIT 100`,
      [req.user!.id],
    );
  });

  app.get("/api/doctor/patients", doctor, async (req) =>
    many(
      db,
      `SELECT g.id AS grant_id, g.patient_id, g.scope, g.expires_at, u.first_name, u.last_name, p.birth_date
         FROM access_grants g JOIN users u ON u.id = g.patient_id JOIN patient_profiles p ON p.user_id = g.patient_id
        WHERE g.doctor_id = $1 AND g.revoked_at IS NULL AND g.expires_at > now() ORDER BY g.created_at DESC`,
      [req.user!.id],
    ),
  );

  /** Every doctor read goes through here: a live grant and a certified doctor, or nothing. */
  async function activeGrant(doctorId: string, patientId: string, what: string): Promise<Scope> {
    await requireCertified(doctorId);
    const g = await one<{ id: string; scope: Scope }>(
      db,
      `SELECT id, scope FROM access_grants WHERE doctor_id = $1 AND patient_id = $2 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY expires_at DESC LIMIT 1`,
      [doctorId, patientId],
    );
    if (!g) throw new HttpError(403, "no_active_access");
    await audit(db, doctorId, patientId, "access.viewed", { grant_id: g.id, what });
    return g.scope;
  }

  const Pid = z.object({ pid: z.string().uuid() });

  app.get("/api/doctor/patients/:pid/records", doctor, async (req) => {
    const { pid } = Pid.parse(req.params);
    return listRecords(ctx, pid, await activeGrant(req.user!.id, pid, "records"));
  });

  app.get("/api/doctor/patients/:pid/trends", doctor, async (req) => {
    const { pid } = Pid.parse(req.params);
    const scope = await activeGrant(req.user!.id, pid, "trends");
    if (scope === "prescriptions") throw new HttpError(403, "outside_scope");
    return labSeries(ctx, pid);
  });

  app.get("/api/doctor/patients/:pid/records/dates/:date/pdf", doctor, async (req, reply) => {
    const { pid, date } = z.object({ pid: z.string().uuid(), date: z.string().date() }).parse(req.params);
    const pdf = await buildDatePdf(ctx, pid, date, await activeGrant(req.user!.id, pid, `pdf:${date}`));
    if (!pdf) throw new HttpError(404, "no_records_on_date");
    return reply.type("application/pdf").header("content-disposition", `attachment; filename="patient-${date}.pdf"`).send(pdf);
  });

  async function expireStale() {
    await db.query("UPDATE access_requests SET status = 'expired' WHERE status = 'pending' AND expires_at <= now()");
  }
}
