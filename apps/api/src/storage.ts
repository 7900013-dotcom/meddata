import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { open, seal } from "./crypto.js";

/**
 * Envelope-encrypted file store. Each file gets its own random key, which is
 * wrapped with the master key and stored in the file header.
 * Layout: "MD1" | wrappedKeyLen(1) | wrappedKey | sealed(content)
 * Swap for S3-compatible object storage in production; keep the same envelope.
 */
export class EncryptedStorage {
  private master: Buffer;
  constructor(private dir: string, masterKeyB64: string) {
    this.master = Buffer.from(masterKeyB64, "base64");
  }

  async put(content: Buffer, prefix: string): Promise<string> {
    const dek = randomBytes(32);
    const wrapped = seal(this.master, dek);
    const body = Buffer.concat([Buffer.from("MD1"), Buffer.from([wrapped.length]), wrapped, seal(dek, content)]);
    const key = `${prefix}/${randomUUID()}`;
    const file = path.join(this.dir, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body, { mode: 0o600 });
    return key;
  }

  async get(key: string): Promise<Buffer> {
    if (key.includes("..")) throw new Error("invalid storage key");
    const body = await readFile(path.join(this.dir, key));
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
