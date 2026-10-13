import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPool, migrate } from "../src/db.js";
import { MemoryNotifier } from "../src/notify.js";
import { DiskBlobStore, EncryptedStorage } from "../src/storage.js";
import type { Ctx } from "../src/context.js";
import type { Extractor } from "../src/documents/extract.js";
import type { Extraction } from "../src/documents/schema.js";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://meddata:meddata@localhost:5432/meddata_test";

export class FakeExtractor implements Extractor {
  next: Extraction = sampleExtraction();
  calls = 0;
  async extract() {
    this.calls++;
    return structuredClone(this.next);
  }
}

export function sampleExtraction(over: Partial<Extraction> = {}): Extraction {
  return {
    document_kind: "lab_result",
    investigation_date: "2026-09-14",
    institution: "Synevo Moldova",
    doctor_name: null,
    title: "Hemoleucogramă completă",
    summary: "Hemoglobina ușor scăzută.",
    transcription: "Hemoglobina 11.2 g/dL (12.0-15.5)\nLeucocite 6.1 10^3/µL (4.0-10.0)",
    diagnoses: [],
    medicines: [],
    lab_values: [
      { test: "Hemoglobina", value: 11.2, value_text: "11.2", unit: "g/dL", ref_low: 12, ref_high: 15.5, uncertain: false },
      { test: "Leucocite", value: 6.1, value_text: "6.1", unit: "10^3/µL", ref_low: 4, ref_high: 10, uncertain: false },
    ],
    uncertain_fields: [],
    ...over,
  };
}

export interface TestEnv {
  ctx: Ctx;
  app: FastifyInstance;
  notifier: MemoryNotifier;
  extractor: FakeExtractor;
  close(): Promise<void>;
}

export async function setup(): Promise<TestEnv> {
  const cfg = loadConfig({ NODE_ENV: "test", DATABASE_URL: TEST_DB, STORAGE_DIR: mkdtempSync(path.join(tmpdir(), "meddata-")), MPASS_MODE: "mock" });
  const db = createPool(cfg.DATABASE_URL);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  const notifier = new MemoryNotifier();
  const extractor = new FakeExtractor();
  const ctx: Ctx = { cfg, db, notifier, extractor, storage: new EncryptedStorage(new DiskBlobStore(cfg.STORAGE_DIR), cfg.STORAGE_MASTER_KEY) };
  const app = await buildApp(ctx);
  return { ctx, app, notifier, extractor, close: async () => (await app.close(), await db.end()) };
}

export const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((c) => c.name === "md_session");
  if (!c) throw new Error("no session cookie");
  return `md_session=${c.value}`;
};

export async function signInPatient(env: TestEnv, email: string): Promise<string> {
  await env.app.inject({ method: "POST", url: "/api/auth/otp/request", payload: { email } });
  const code = env.notifier.last(email.toLowerCase())!.text.match(/\b(\d{6})\b/)![1];
  const res = await env.app.inject({ method: "POST", url: "/api/auth/otp/verify", payload: { email, code } });
  if (res.statusCode !== 200) throw new Error(res.body);
  return cookieOf(res);
}

export async function signInDoctor(env: TestEnv, idnp: string, certified = true): Promise<{ cookie: string; id: string }> {
  const res = await env.app.inject({ method: "POST", url: "/auth/mpass/mock", payload: { idnp, firstName: "Ion", lastName: "Rusu" } });
  const cookie = cookieOf(res);
  const me = await env.app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
  const id = me.json().user.id;
  if (certified) await env.ctx.db.query("UPDATE doctor_profiles SET status = 'certified' WHERE user_id = $1", [id]);
  return { cookie, id };
}

/** Smallest valid PNG: w x h grey pixels. */
export function png(w = 4, h = 4): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w, 0x80)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export function multipartBody(files: { name: string; filename: string; type: string; data: Buffer }[], fields: Record<string, string> = {}) {
  const boundary = "----meddata" + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`));
    parts.push(f.data, Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
