import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";

export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** Keyed hash for short secrets (OTP codes, share codes) so a database leak doesn't reveal them. */
export const hmac = (key: string, value: string) => createHmac("sha256", key).update(value).digest("hex");

export const safeEqual = (a: string, b: string) => {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

export const numericCode = (digits = 6) => String(randomInt(0, 10 ** digits)).padStart(digits, "0");

// Unambiguous characters for codes a person types (no 0/O, 1/I/L).
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const shortCode = (len = 8) => Array.from({ length: len }, () => CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)]).join("");

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** scrypt hash for the patient's approval PIN. Format: scrypt$salt$hash */
export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${scryptSync(pin, salt, 32).toString("base64")}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [alg, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const got = scryptSync(pin, Buffer.from(salt, "base64"), 32);
  return timingSafeEqual(got, Buffer.from(hash, "base64"));
}

/** AES-256-GCM. Output: iv(12) | tag(16) | ciphertext */
export function seal(key: Buffer, plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function open(key: Buffer, sealed: Buffer): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
  d.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
}
