import type { FastifyInstance, FastifyReply } from "fastify";
import { SAML, ValidateInResponseTo, type Profile } from "@node-saml/node-saml";
import { z } from "zod";
import { HttpError, type Ctx } from "../context.js";
import { one } from "../db.js";
import { audit } from "../audit.js";
import { safeEqual } from "../crypto.js";
import type { Sessions } from "./session.js";

export interface MPassIdentity {
  idnp: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}

const IDNP = z.string().regex(/^\d{13}$/, "IDNP has 13 digits");

/**
 * Doctor sign-in via MPass, Moldova's government identity service (SAML 2.0).
 * MPASS_MODE=mock serves a local form so the flow can be developed without
 * MPass credentials; in production it additionally requires MPASS_MOCK_ACCESS_CODE.
 */
export function mpassRoutes(app: FastifyInstance, ctx: Ctx, sessions: Sessions) {
  const { cfg, db } = ctx;
  const acsUrl = `${cfg.API_URL}/auth/mpass/acs`;

  async function signIn(reply: FastifyReply, id: MPassIdentity) {
    const idnp = IDNP.parse(id.idnp);
    let user = await one<{ id: string; role: string }>(db, "SELECT id, role FROM users WHERE idnp = $1", [idnp]);
    if (user && user.role !== "doctor") throw new HttpError(403, "idnp_bound_to_non_doctor_account");
    if (!user) {
      user = await one(db, "INSERT INTO users(role, idnp, first_name, last_name, email) VALUES ('doctor', $1, $2, $3, $4) RETURNING id, role", [
        idnp,
        id.firstName ?? null,
        id.lastName ?? null,
        id.email?.toLowerCase() ?? null,
      ]);
      await db.query("INSERT INTO doctor_profiles(user_id) VALUES ($1)", [user!.id]);
      await audit(db, user!.id, null, "doctor.registered", { via: "mpass" });
    } else {
      // MPass is the source of truth for the doctor's legal name.
      await db.query("UPDATE users SET first_name = coalesce($2, first_name), last_name = coalesce($3, last_name) WHERE id = $1", [
        user.id,
        id.firstName ?? null,
        id.lastName ?? null,
      ]);
    }
    await sessions.issue(reply, { id: user!.id, role: "doctor" });
    await audit(db, user!.id, null, "doctor.signed_in", { via: "mpass" });
    return reply.redirect(`${cfg.PUBLIC_URL}/doctor`);
  }

  if (cfg.MPASS_MODE === "mock") {
    const accessCode = cfg.MPASS_MOCK_ACCESS_CODE;
    app.get("/auth/mpass/login", async (_req, reply) => reply.redirect("/auth/mpass/mock"));
    app.get("/auth/mpass/mock", async (_req, reply) =>
      reply.type("text/html").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MPass (stand-in)</title>
<style>body{font:16px system-ui;max-width:420px;margin:60px auto;padding:0 16px}input,button{display:block;width:100%;margin:8px 0;padding:10px;font:inherit}</style>
<h2>MPass (stand-in)</h2><p>This page stands in for MPass until MedData is registered with the e-Government Agency.</p>
<form method="post" action="/auth/mpass/mock">
<input name="idnp" placeholder="IDNP (13 digits)" required pattern="\\d{13}">
<input name="firstName" placeholder="First name"><input name="lastName" placeholder="Last name"><input name="email" placeholder="Email">
${accessCode ? '<input name="accessCode" type="password" placeholder="Access code (ask the MedData team)" required>' : ""}
<button>Sign in</button></form>`),
    );
    app.post("/auth/mpass/mock", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
      const b = z
        .object({ idnp: z.string(), firstName: z.string().optional(), lastName: z.string().optional(), email: z.string().optional(), accessCode: z.string().optional() })
        .parse(req.body);
      if (accessCode && !safeEqual(b.accessCode ?? "", accessCode)) throw new HttpError(403, "wrong_access_code", "Wrong access code.");
      return signIn(reply, { ...b, email: b.email || undefined });
    });
    return;
  }

  if (!cfg.MPASS_ENTRY_POINT || !cfg.MPASS_IDP_CERT) throw new Error("MPASS_ENTRY_POINT and MPASS_IDP_CERT are required when MPASS_MODE=saml");
  const saml = new SAML({
    entryPoint: cfg.MPASS_ENTRY_POINT,
    logoutUrl: cfg.MPASS_LOGOUT_URL,
    issuer: cfg.MPASS_ISSUER,
    callbackUrl: acsUrl,
    idpCert: cfg.MPASS_IDP_CERT,
    privateKey: cfg.MPASS_SP_PRIVATE_KEY,
    publicCert: cfg.MPASS_SP_CERT,
    decryptionPvk: cfg.MPASS_SP_PRIVATE_KEY,
    signatureAlgorithm: "sha256",
    wantAssertionsSigned: true,
    validateInResponseTo: ValidateInResponseTo.always,
    identifierFormat: null,
  });

  const attr = (p: Profile, name: string): string | undefined => {
    if (name === "nameID") return p.nameID;
    const v = (p as Record<string, unknown>)[name] ?? (p.attributes as Record<string, unknown> | undefined)?.[name];
    return Array.isArray(v) ? String(v[0]) : v == null ? undefined : String(v);
  };

  app.get("/auth/mpass/login", async (_req, reply) => reply.redirect(await saml.getAuthorizeUrlAsync("", undefined, {})));

  app.post("/auth/mpass/acs", async (req, reply) => {
    const { profile } = await saml.validatePostResponseAsync(req.body as Record<string, string>);
    if (!profile) throw new HttpError(400, "mpass_no_profile");
    return signIn(reply, {
      idnp: attr(profile, cfg.MPASS_ATTR_IDNP) ?? "",
      firstName: attr(profile, cfg.MPASS_ATTR_FIRST_NAME),
      lastName: attr(profile, cfg.MPASS_ATTR_LAST_NAME),
      email: attr(profile, cfg.MPASS_ATTR_EMAIL),
    });
  });

  app.get("/auth/mpass/metadata", async (_req, reply) =>
    reply.type("application/xml").send(saml.generateServiceProviderMetadata(cfg.MPASS_SP_CERT ?? null, cfg.MPASS_SP_CERT ?? null)),
  );
}
