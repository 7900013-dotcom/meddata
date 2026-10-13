import type { FastifyRequest } from "fastify";
import { HttpError } from "./context.js";

export interface UploadedFile {
  filename: string;
  mimetype: string;
  buffer: Buffer;
}

export async function readMultipart(req: FastifyRequest): Promise<{ fields: Record<string, string>; files: UploadedFile[] }> {
  if (!req.isMultipart()) throw new HttpError(415, "multipart_required");
  const fields: Record<string, string> = {};
  const files: UploadedFile[] = [];
  for await (const part of req.parts()) {
    if (part.type === "file") files.push({ filename: part.filename, mimetype: part.mimetype, buffer: await part.toBuffer() });
    else fields[part.fieldname] = String(part.value);
  }
  return { fields, files };
}

const MAGIC: [string, (b: Buffer) => boolean][] = [
  ["application/pdf", (b) => b.subarray(0, 5).toString() === "%PDF-"],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/png", (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["image/webp", (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP"],
  ["image/heic", (b) => b.subarray(4, 12).toString().startsWith("ftyphei") || b.subarray(4, 12).toString().startsWith("ftypmif1")],
];

/** Trust the bytes, not the browser-supplied content type. */
export function sniffMime(buf: Buffer): string | null {
  return MAGIC.find(([, test]) => test(buf))?.[0] ?? null;
}
