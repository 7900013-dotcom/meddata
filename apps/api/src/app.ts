import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import formbody from "@fastify/formbody";
import rateLimit from "@fastify/rate-limit";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { HttpError, type Ctx } from "./context.js";
import { one } from "./db.js";
import { Sessions } from "./auth/session.js";
import { patientAuthRoutes } from "./auth/patient.js";
import { mpassRoutes } from "./auth/mpass.js";
import { doctorRoutes } from "./doctors/routes.js";
import { documentRoutes } from "./documents/routes.js";
import { accessRoutes } from "./access/routes.js";
import { mailRoutes } from "./mail/routes.js";
import { MAX_FILE_BYTES } from "./documents/service.js";

export async function buildApp(ctx: Ctx): Promise<FastifyInstance> {
  const app = Fastify({
    logger: ctx.cfg.NODE_ENV === "test" ? false : { redact: ["req.headers.cookie", "req.headers.authorization"] },
    trustProxy: true,
  });
  const sessions = new Sessions(ctx.cfg.SESSION_SECRET, ctx.cfg.NODE_ENV === "production");

  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: 20 } });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(cors, { origin: ctx.cfg.PUBLIC_URL, credentials: true });

  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    req.user = await sessions.read(req);
  });
  app.addHook("onSend", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: "invalid_input", issues: err.issues });
    if (err instanceof HttpError)
      return reply.status(err.status).send({ error: err.code, message: err.message, details: (err as { details?: unknown }).details });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as { code?: string }).code ?? "bad_request", message: (err as Error).message });
    req.log.error(err);
    return reply.status(500).send({ error: "internal_error" });
  });

  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/me", async (req) => {
    if (!req.user) return { user: null };
    const u = await one(
      ctx.db,
      `SELECT u.id, u.role, u.email, u.phone, u.first_name, u.last_name, p.approval_pin_hash IS NOT NULL AS has_pin, d.status AS doctor_status
         FROM users u LEFT JOIN patient_profiles p ON p.user_id = u.id LEFT JOIN doctor_profiles d ON d.user_id = u.id WHERE u.id = $1`,
      [req.user.id],
    );
    return { user: u };
  });
  app.post("/api/auth/logout", async (_req, reply) => {
    sessions.clear(reply);
    return { ok: true };
  });

  patientAuthRoutes(app, ctx, sessions);
  mpassRoutes(app, ctx, sessions);
  doctorRoutes(app, ctx);
  documentRoutes(app, ctx);
  accessRoutes(app, ctx);
  mailRoutes(app, ctx);

  // Single-process deploys: serve the built web app from the API, with history-API fallback for client routes.
  if (ctx.cfg.WEB_DIST && existsSync(path.join(ctx.cfg.WEB_DIST, "index.html"))) {
    await app.register(fastifyStatic, { root: path.resolve(ctx.cfg.WEB_DIST), wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/auth/")) return reply.status(404).send({ error: "not_found" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
