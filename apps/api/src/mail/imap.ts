import { ImapFlow } from "imapflow";
import type { Ctx } from "../context.js";
import { many, one } from "../db.js";
import { ingestEmail } from "./ingest.js";

const FIRST_SYNC_DAYS = 365;

/** Fetches new messages from one connected mailbox, imports lab emails, and remembers where it stopped. */
export async function pollMailSource(ctx: Ctx, sourceId: string) {
  const src = await one(ctx.db, "SELECT * FROM mail_sources WHERE id = $1 AND enabled", [sourceId]);
  if (!src) return { imported: 0 };
  const client = new ImapFlow({
    host: src.imap_host,
    port: src.imap_port,
    secure: src.imap_port === 993,
    auth: { user: src.username, pass: ctx.storage.decryptSecret(src.secret_enc) },
    logger: false,
  });
  let imported = 0;
  let lastUid: number = src.last_uid;
  try {
    await client.connect();
    const lock = await client.getMailboxLock(src.mailbox);
    try {
      const query = lastUid > 0 ? { uid: `${lastUid + 1}:*` } : { since: new Date(Date.now() - FIRST_SYNC_DAYS * 864e5) };
      // Ask the server for messages from each lab sender, then check the sender again locally.
      const uids = new Set<number>();
      for (const p of src.sender_patterns as string[]) {
        const found = await client.search({ ...query, from: p }, { uid: true });
        for (const u of found || []) if (u > lastUid) uids.add(u);
      }
      for (const uid of [...uids].sort((a, b) => a - b)) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (msg && msg.source) {
          const r = await ingestEmail(ctx, src.patient_id, msg.source, src.sender_patterns);
          imported += r.documents.filter((d) => !d.duplicate).length;
        }
        lastUid = Math.max(lastUid, uid);
      }
    } finally {
      lock.release();
    }
    await ctx.db.query("UPDATE mail_sources SET last_uid = $2, last_polled_at = now(), last_error = NULL WHERE id = $1", [sourceId, lastUid]);
  } catch (e) {
    await ctx.db.query("UPDATE mail_sources SET last_polled_at = now(), last_error = $2 WHERE id = $1", [sourceId, String((e as Error).message).slice(0, 300)]);
    throw e;
  } finally {
    await client.logout().catch(() => undefined);
  }
  return { imported };
}

export async function pollAll(ctx: Ctx, log: { error: (o: object, m: string) => void }) {
  for (const { id } of await many<{ id: string }>(ctx.db, "SELECT id FROM mail_sources WHERE enabled")) {
    await pollMailSource(ctx, id).catch((err) => log.error({ err, source: id }, "mail poll failed"));
  }
}
