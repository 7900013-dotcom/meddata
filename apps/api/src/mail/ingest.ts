import { simpleParser, type AddressObject } from "mailparser";
import type { Ctx } from "../context.js";
import { HttpError } from "../context.js";
import { sniffMime } from "../multipart.js";
import { processDocument, storeOriginal } from "../documents/service.js";

/** Known labs. Patterns match the sender address or domain; verify against a real results email before relying on them. */
export const KNOWN_LABS: Record<string, string[]> = {
  synevo: ["synevo.md"],
};

export function senderAddresses(from: AddressObject | AddressObject[] | undefined): string[] {
  const list = Array.isArray(from) ? from : from ? [from] : [];
  return list.flatMap((a) => a.value.map((v) => (v.address ?? "").toLowerCase())).filter(Boolean);
}

export function senderMatches(addresses: string[], patterns: string[]): boolean {
  return addresses.some((addr) =>
    patterns.some((p) => {
      const pat = p.toLowerCase().trim();
      return pat.includes("@") ? addr === pat : addr.endsWith(`@${pat}`) || addr.endsWith(`.${pat}`);
    }),
  );
}

export interface IngestResult {
  matched: boolean;
  from: string[];
  subject: string;
  documents: { id: string; duplicate: boolean; filename: string }[];
  note?: "no_attachments";
}

/**
 * Takes one raw email. If it comes from a lab the patient connected, every PDF or
 * image attachment is stored as an original and read; results then wait in the
 * patient's inbox for a one-tap review, like uploads do.
 */
export async function ingestEmail(
  ctx: Ctx,
  patientId: string,
  raw: Buffer,
  patterns: string[],
  opts: { process?: boolean } = {},
): Promise<IngestResult> {
  const mail = await simpleParser(raw);
  const from = senderAddresses(mail.from);
  const subject = mail.subject ?? "";
  if (!senderMatches(from, patterns)) return { matched: false, from, subject, documents: [] };

  const documents: IngestResult["documents"] = [];
  for (const att of mail.attachments) {
    const mime = sniffMime(att.content);
    if (!mime || mime === "image/heic") continue;
    try {
      const stored = await storeOriginal(ctx, patientId, {
        buffer: att.content,
        filename: att.filename ?? `${subject || "lab-result"}.${mime === "application/pdf" ? "pdf" : "jpg"}`,
        source: "email",
        emailMessageId: mail.messageId,
        emailFrom: from[0],
      });
      documents.push({ ...stored, filename: att.filename ?? "" });
      if (!stored.duplicate && opts.process !== false) await processDocument(ctx, stored.id);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
    }
  }
  return { matched: true, from, subject, documents, note: documents.length ? undefined : "no_attachments" };
}
