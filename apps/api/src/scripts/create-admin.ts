import { loadConfig } from "../config.js";
import { createPool } from "../db.js";

// Usage: npm -w apps/api run create-admin -- admin@example.com   (the admin then signs in with an email code)
const email = process.argv[2]?.toLowerCase();
if (!email) throw new Error("usage: create-admin <email>");
const db = createPool(loadConfig().DATABASE_URL);
await db.query("INSERT INTO users(role, email) VALUES ('admin', $1) ON CONFLICT (email) DO UPDATE SET role = 'admin'", [email]);
console.log(`admin: ${email}`);
await db.end();
