import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { open, seal } from "./crypto.js";
import type pg from "pg";

export interface BlobStore {
  write(key: string, body: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
}

export class DiskBlobStore implements BlobStore {
  constructor(private dir: string) {}
  async write(key: string, body: Buffer) {
    const file = path.join(this.dir, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body, { mode: 0o600 });
  }
  async read(key: string) {
    return readFile(path.join(this.dir, key));
  }
}

/** Keeps the (already encrypted) bodies in Postgres, for hosts with no persistent disk. */
export class DbBlobStore implements BlobStore {
  constructor(private db: pg.Pool) {}
  async write(key: string, body: Buffer) {
    await this.db.query("INSERT INTO file_blobs(key, body) VALUES ($1, $2)", [key, body]);
  }
  async read(key: string) {
    const r = await this.db.query("SELECT body FROM file_blobs WHERE key = $1", [key]);
    if (!r.rows[0]) throw new Error("file not found");
    return r.rows[0].body as Buffer;
  }
}

/**
 * Envelope-encrypted file store. Each file gets its own random key, which is
 * wrapped with the master key and stored in the file header.
 * Layout: "MD1" | wrappedKeyLen(1) | wrappedKey | sealed(content)
 * Bodies go to a BlobStore (local disk or Postgres); S3 would be a third one with the same envelope.
 */
export class EncryptedStorage {
  private master: Buffer;
  constructor(private store: BlobStore, masterKeyB64: string) {
    this.master = Buffer.from(masterKeyB64, "base64");
  }

  async put(content: Buffer, prefix: string): Promise<string> {
    const dek = randomBytes(32);
    const wrapped = seal(this.master, dek);
    const body = Buffer.concat([Buffer.from("MD1"), Buffer.from([wrapped.length]), wrapped, seal(dek, content)]);
    const key = `${prefix}/${randomUUID()}`;
    await this.store.write(key, body);
    return key;
  }

  async get(key: string): Promise<Buffer> {
    if (key.includes("..")) throw new Error("invalid storage key");
    const body = await this.store.read(key);
    if (body.subarray(0, 3).toString() !== "MD1") throw new Error("unknown file format");
    const wl = body[3];
    const dek = open(this.master, body.subarray(4, 4 + wl));
    return open(dek, body.subarray(4 + wl));
  }

  encryptSecret(plain: string): string {
    return seal(this.master, Buffer.from(plain)).toString("base64");
  }

  decryptSecret(enc: string): string {
    return open(this.master, Buffer.from(enc, "base64")).toString();
  }
}
