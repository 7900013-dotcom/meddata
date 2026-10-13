import { createContext } from "../bootstrap.js";
import { pollAll } from "../mail/imap.js";

// Runs forever; deploy as its own worker process (or a cron job with --once).
const ctx = createContext();
const intervalMin = Number(process.env.MAIL_POLL_MINUTES ?? 15);
do {
  await pollAll(ctx, console);
  if (process.argv.includes("--once")) break;
  await new Promise((r) => setTimeout(r, intervalMin * 60_000));
} while (true);
await ctx.db.end();
