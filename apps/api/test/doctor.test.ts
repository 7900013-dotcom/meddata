import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup, signInDoctor, signInPatient, multipartBody, png, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeAll(async () => (env = await setup()));
afterAll(() => env.close());

describe("doctor registration via MPass and certification", () => {
  it("creates an unverified doctor on first MPass sign-in", async () => {
    const res = await env.app.inject({ method: "POST", url: "/auth/mpass/mock", payload: { idnp: "2001234567890", firstName: "Maria", lastName: "Ciobanu" } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/\/doctor$/);
  });

  it("rejects a malformed IDNP", async () => {
    const res = await env.app.inject({ method: "POST", url: "/auth/mpass/mock", payload: { idnp: "123" } });
    expect(res.statusCode).toBe(400);
  });

  it("does not let doctors sign in with an email code", async () => {
    const { id } = await signInDoctor(env, "2001234567891", false);
    await env.ctx.db.query("UPDATE users SET email = 'dr@example.com' WHERE id = $1", [id]);
    await env.app.inject({ method: "POST", url: "/api/auth/otp/request", payload: { email: "dr@example.com" } });
    const code = env.notifier.last("dr@example.com")!.text.match(/\b(\d{6})\b/)![1];
    const r = await env.app.inject({ method: "POST", url: "/api/auth/otp/verify", payload: { email: "dr@example.com", code } });
    expect(r.json().error).toBe("doctors_use_mpass");
  });

  it("goes unverified -> pending -> certified through admin review", async () => {
    const { cookie, id } = await signInDoctor(env, "2001234567892", false);
    const body = multipartBody([{ name: "license", filename: "licenta.png", type: "image/png", data: png() }], {
      license_number: "MD-12345",
      specialty: "Cardiologie",
      institution: "IMSP Spitalul Clinic Republican",
    });
    const sub = await env.app.inject({ method: "POST", url: "/api/doctor/certification", headers: { cookie, ...body.headers }, payload: body.payload });
    expect(sub.json()).toEqual({ status: "pending" });

    // A patient cannot act as an admin.
    const patient = await signInPatient(env, "notadmin@example.com");
    const denied = await env.app.inject({ method: "POST", url: `/api/admin/certifications/${id}`, headers: { cookie: patient }, payload: { decision: "certify" } });
    expect(denied.statusCode).toBe(403);

    await env.ctx.db.query("INSERT INTO users(role, email) VALUES ('admin', 'admin@example.com')");
    const admin = await signInPatient(env, "admin@example.com");
    const queue = await env.app.inject({ method: "GET", url: "/api/admin/certifications", headers: { cookie: admin } });
    expect(queue.json().map((d: { id: string }) => d.id)).toContain(id);
    const lic = await env.app.inject({ method: "GET", url: `/api/admin/certifications/${id}/license`, headers: { cookie: admin } });
    expect(lic.headers["content-type"]).toBe("image/png");

    const ok = await env.app.inject({ method: "POST", url: `/api/admin/certifications/${id}`, headers: { cookie: admin }, payload: { decision: "certify" } });
    expect(ok.json()).toEqual({ status: "certified" });
    const me = await env.app.inject({ method: "GET", url: "/api/doctor/me", headers: { cookie } });
    expect(me.json().status).toBe("certified");
  });
});
