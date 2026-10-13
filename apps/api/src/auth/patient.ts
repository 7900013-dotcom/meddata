import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, type Ctx } from "../context.js";
import { one } from "../db.js";
import { hashPin, hmac, numericCode, safeEqual } from "../crypto.js";
import { audit } from "../audit.js";
import { requireRole, type Sessions } from "./session.js";

const Destination = z.union([
  z.object({ email: z.string().email().transform((s) => s.trim().toLowerCase()) }),
  // E.164, e.g. +37369123456
  z.object({ phone: z.string().regex(/^\+[1-9]\d{7,14}$/, "phone must be in international format, e.g. +37369123456") }),
]);

const MAX_CODES_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

/** Patients (and admins) sign in with a one-time code sent by email or SMS. No passwords. */
export function patientAuthRoutes(app: FastifyInstance, ctx: Ctx, sessions: Sessions) {
  const { db, cfg, notifier } = ctx;
  const codeHash = (dest: string, code: string) => hmac(cfg.SESSION_SECRET, `${dest}:${code}`);

  app.post("/api/auth/otp/request", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const d = Destination.parse(req.body);
    const [channel, dest] = "email" in d ? (["email", d.email] as const) : (["sms", d.phone] as const);
    const recent = await one<{ n: number }>(
      db,
      "SELECT count(*)::int AS n FROM otp_codes WHERE destination = $1 AND created_at > now() - interval '1 hour'",
      [dest],
    );
    if ((recent?.n ?? 0) >= MAX_CODES_PER_HOUR) throw new HttpError(429, "too_many_codes");
    const code = numericCode(6);
    await db.query(
      `INSERT INTO otp_codes(channel, destination, code_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
      [channel, dest, codeHash(dest, code), cfg.OTP_TTL_MINUTES],
    );
    const text = `MedData sign-in code: ${code}. It expires in ${cfg.OTP_TTL_MINUTES} minutes. Never share it.`;
    if (channel === "email") await notifier.email(dest, "Your MedData sign-in code", text);
    else await notifier.sms(dest, text);
    return { sent: true, channel };
  });

  app.post("/api/auth/otp/verify", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = z.intersection(Destination, z.object({ code: z.string().regex(/^\d{6}$/) })).parse(req.body);
    const dest = "email" in body ? body.email : body.phone;
    const row = await one<{ id: string; code_hash: string; attempts: number }>(
      db,
      `SELECT id, code_hash, attempts FROM otp_codes
        WHERE destination = $1 AND consumed_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1`,
      [dest],
    );
    if (!row || row.attempts >= MAX_ATTEMPTS) throw new HttpError(400, "code_expired");
    if (!safeEqual(row.code_hash, codeHash(dest, body.code))) {
      await db.query("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1", [row.id]);
      throw new HttpError(400, "wrong_code");
    }
    await db.query("UPDATE otp_codes SET consumed_at = now() WHERE id = $1", [row.id]);

    const col = "email" in body ? "email" : "phone";
    let user = await one<{ id: string; role: "patient" | "admin" | "doctor" }>(db, `SELECT id, role FROM users WHERE ${col} = $1`, [dest]);
    let created = false;
    if (!user) {
      user = await one(db, `INSERT INTO users(role, ${col}) VALUES ('patient', $1) RETURNING id, role`, [dest]);
      await db.query("INSERT INTO patient_profiles(user_id) VALUES ($1)", [user!.id]);
      created = true;
      await audit(db, user!.id, user!.id, "patient.registered", { via: col });
    }
    // Doctors sign in only through MPass.
    if (user!.role === "doctor") throw new HttpError(403, "doctors_use_mpass");
    await sessions.issue(reply, { id: user!.id, role: user!.role });
    return { user: { id: user!.id, role: user!.role }, created };
  });

  app.put("/api/patient/approval-pin", { preHandler: requireRole("patient") }, async (req) => {
    const { pin } = z.object({ pin: z.string().regex(/^\d{6}$/, "PIN must be 6 digits") }).parse(req.body);
    await db.query("UPDATE patient_profiles SET approval_pin_hash = $2 WHERE user_id = $1", [req.user!.id, hashPin(pin)]);
    await audit(db, req.user!.id, req.user!.id, "patient.pin_set");
    return { ok: true };
  });

  app.put("/api/patient/profile", { preHandler: requireRole("patient") }, async (req) => {
    const p = z
      .object({ first_name: z.string().max(80).optional(), last_name: z.string().max(80).optional(), birth_date: z.string().date().optional() })
      .parse(req.body);
    await db.query("UPDATE users SET first_name = coalesce($2, first_name), last_name = coalesce($3, last_name) WHERE id = $1", [
      req.user!.id,
      p.first_name,
      p.last_name,
    ]);
    if (p.birth_date) await db.query("UPDATE patient_profiles SET birth_date = $2 WHERE user_id = $1", [req.user!.id, p.birth_date]);
    return { ok: true };
  });
}
