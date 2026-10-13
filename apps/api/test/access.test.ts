import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { multipartBody, png, sampleExtraction, setup, signInDoctor, signInPatient, type TestEnv } from "./helpers.js";

let env: TestEnv;
let patient: string;
beforeAll(async () => {
  env = await setup();
  patient = await signInPatient(env, "patient@example.com");
  await env.app.inject({ method: "PUT", url: "/api/patient/approval-pin", headers: { cookie: patient }, payload: { pin: "135790" } });
  // One lab result and one prescription on file.
  for (const [i, ex] of [sampleExtraction(), sampleExtraction({ document_kind: "prescription", title: "Rețetă", lab_values: [], investigation_date: "2026-09-20" })].entries()) {
    env.extractor.next = ex;
    const body = multipartBody([{ name: "file", filename: `p${i}.png`, type: "image/png", data: png(4 + i, 4) }]);
    const up = await env.app.inject({ method: "POST", url: "/api/documents?wait=true", headers: { cookie: patient, ...body.headers }, payload: body.payload });
    const id = up.json().documents[0].id;
    await env.app.inject({ method: "POST", url: `/api/documents/${id}/confirm`, headers: { cookie: patient }, payload: ex });
  }
});
afterAll(() => env.close());

const share = async () => (await env.app.inject({ method: "POST", url: "/api/share-tokens", headers: { cookie: patient } })).json();

describe("doctor access with patient approval", () => {
  it("refuses requests from doctors who are not certified", async () => {
    const { cookie } = await signInDoctor(env, "2009999999990", false);
    const { short_code } = await share();
    const r = await env.app.inject({ method: "POST", url: "/api/doctor/access-requests", headers: { cookie }, payload: { short_code } });
    expect(r.json().error).toBe("doctor_not_certified");
  });

  it("runs the full QR -> request -> PIN approval -> view -> revoke flow", async () => {
    const { cookie: dr } = await signInDoctor(env, "2009999999991");
    const s = await share();
    expect(s.qr_svg).toContain("<svg");
    const token = new URL(s.url).searchParams.get("t");

    const req = await env.app.inject({ method: "POST", url: "/api/doctor/access-requests", headers: { cookie: dr }, payload: { token, scope: "labs", duration_hours: 2 } });
    expect(req.json().status).toBe("pending");
    expect(env.notifier.last("patient@example.com")?.text).toContain("asks to see your MedData records");

    // The QR works once.
    const reuse = await env.app.inject({ method: "POST", url: "/api/doctor/access-requests", headers: { cookie: dr }, payload: { token } });
    expect(reuse.json().error).toBe("code_invalid_or_expired");

    // No access before approval.
    const patients0 = (await env.app.inject({ method: "GET", url: "/api/doctor/patients", headers: { cookie: dr } })).json();
    expect(patients0).toHaveLength(0);

    const id = req.json().request_id;
    const wrong = await env.app.inject({ method: "POST", url: `/api/access/requests/${id}/approve`, headers: { cookie: patient }, payload: { pin: "000000" } });
    expect(wrong.json().error).toBe("wrong_pin");
    const ok = await env.app.inject({ method: "POST", url: `/api/access/requests/${id}/approve`, headers: { cookie: patient }, payload: { pin: "135790" } });
    expect(ok.statusCode).toBe(200);

    const [p] = (await env.app.inject({ method: "GET", url: "/api/doctor/patients", headers: { cookie: dr } })).json();
    const records = (await env.app.inject({ method: "GET", url: `/api/doctor/patients/${p.patient_id}/records`, headers: { cookie: dr } })).json();
    // Scope "labs": the prescription stays hidden.
    expect(records.map((r: { kind: string }) => r.kind)).toEqual(["lab_result"]);
    const pdf = await env.app.inject({ method: "GET", url: `/api/doctor/patients/${p.patient_id}/records/dates/2026-09-14/pdf`, headers: { cookie: dr } });
    expect(pdf.headers["content-type"]).toBe("application/pdf");

    const log = (await env.app.inject({ method: "GET", url: "/api/access/log", headers: { cookie: patient } })).json();
    expect(log.map((l: { action: string }) => l.action)).toContain("access.viewed");

    await env.app.inject({ method: "DELETE", url: `/api/access/grants/${ok.json().grant_id}`, headers: { cookie: patient } });
    const after = await env.app.inject({ method: "GET", url: `/api/doctor/patients/${p.patient_id}/records`, headers: { cookie: dr } });
    expect(after.json().error).toBe("no_active_access");
  });

  it("locks approvals after five wrong PINs", async () => {
    const { cookie: dr } = await signInDoctor(env, "2009999999992");
    const { short_code } = await share();
    const id = (await env.app.inject({ method: "POST", url: "/api/doctor/access-requests", headers: { cookie: dr }, payload: { short_code } })).json().request_id;
    for (let i = 0; i < 5; i++) await env.app.inject({ method: "POST", url: `/api/access/requests/${id}/approve`, headers: { cookie: patient }, payload: { pin: "999999" } });
    const r = await env.app.inject({ method: "POST", url: `/api/access/requests/${id}/approve`, headers: { cookie: patient }, payload: { pin: "135790" } });
    expect(r.json().error).toBe("pin_locked");
    await env.ctx.db.query("UPDATE patient_profiles SET pin_locked_until = NULL");
  });

  it("revokes every grant when an admin suspends a doctor", async () => {
    const { cookie: dr, id: drId } = await signInDoctor(env, "2009999999993");
    const { short_code } = await share();
    const id = (await env.app.inject({ method: "POST", url: "/api/doctor/access-requests", headers: { cookie: dr }, payload: { short_code } })).json().request_id;
    await env.app.inject({ method: "POST", url: `/api/access/requests/${id}/approve`, headers: { cookie: patient }, payload: { pin: "135790" } });
    await env.ctx.db.query("INSERT INTO users(role, email) VALUES ('admin', 'a2@example.com')");
    const admin = await signInPatient(env, "a2@example.com");
    await env.app.inject({ method: "POST", url: `/api/admin/certifications/${drId}`, headers: { cookie: admin }, payload: { decision: "suspend" } });
    const list = (await env.app.inject({ method: "GET", url: "/api/doctor/patients", headers: { cookie: dr } })).json();
    expect(list).toHaveLength(0);
  });
});
