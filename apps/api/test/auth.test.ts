import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup, signInPatient, cookieOf, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeAll(async () => (env = await setup()));
afterAll(() => env.close());

describe("patient sign-in with a one-time code", () => {
  it("registers a new patient by email and signs them in", async () => {
    const cookie = await signInPatient(env, "Ana@Example.com");
    const me = await env.app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    expect(me.json().user).toMatchObject({ role: "patient", email: "ana@example.com", has_pin: false });
  });

  it("sends the code by SMS for phone numbers", async () => {
    const res = await env.app.inject({ method: "POST", url: "/api/auth/otp/request", payload: { phone: "+37369123456" } });
    expect(res.json()).toEqual({ sent: true, channel: "sms" });
    expect(env.notifier.last("+37369123456")?.channel).toBe("sms");
  });

  it("rejects phone numbers not in international format", async () => {
    const res = await env.app.inject({ method: "POST", url: "/api/auth/otp/request", payload: { phone: "069123456" } });
    expect(res.statusCode).toBe(400);
  });

  it("locks a code after five wrong attempts", async () => {
    const email = "brute@example.com";
    await env.app.inject({ method: "POST", url: "/api/auth/otp/request", payload: { email } });
    const code = env.notifier.last(email)!.text.match(/\b(\d{6})\b/)![1];
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const r = await env.app.inject({ method: "POST", url: "/api/auth/otp/verify", payload: { email, code: wrong } });
      expect(r.json().error).toBe("wrong_code");
    }
    const r = await env.app.inject({ method: "POST", url: "/api/auth/otp/verify", payload: { email, code } });
    expect(r.json().error).toBe("code_expired");
  });

  it("does not let a code be used twice", async () => {
    const email = "once@example.com";
    await env.app.inject({ method: "POST", url: "/api/auth/otp/request", payload: { email } });
    const code = env.notifier.last(email)!.text.match(/\b(\d{6})\b/)![1];
    const first = await env.app.inject({ method: "POST", url: "/api/auth/otp/verify", payload: { email, code } });
    expect(cookieOf(first)).toBeTruthy();
    const again = await env.app.inject({ method: "POST", url: "/api/auth/otp/verify", payload: { email, code } });
    expect(again.statusCode).toBe(400);
  });

  it("sets a 6-digit approval PIN", async () => {
    const cookie = await signInPatient(env, "pin@example.com");
    const bad = await env.app.inject({ method: "PUT", url: "/api/patient/approval-pin", headers: { cookie }, payload: { pin: "12" } });
    expect(bad.statusCode).toBe(400);
    await env.app.inject({ method: "PUT", url: "/api/patient/approval-pin", headers: { cookie }, payload: { pin: "482913" } });
    const me = await env.app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    expect(me.json().user.has_pin).toBe(true);
  });
});
