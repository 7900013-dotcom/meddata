import { readFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { createPool, tx } from "../db.js";
import { normalizeMedicineName } from "../medicines/register.js";

/**
 * Loads Moldova's medicines register (AMDM "Nomenclatorul de stat al medicamentelor") from a CSV export.
 * Usage: npm run import:medicines -- path/to/nomenclator.csv
 * Columns are matched by header name; adjust COLS if the export uses different headers.
 */
const COLS = {
  name: ["denumirea comerciala", "denumire comerciala", "name"],
  inn: ["dci", "denumirea comuna internationala", "inn"],
  form: ["forma farmaceutica", "form"],
  strength: ["doza", "concentratia", "strength"],
  registration_number: ["nr. de inregistrare", "numarul de inregistrare", "registration_number"],
};

function parseCsv(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) row.push(cur), (cur = "");
    else if (ch === "\n") row.push(cur), rows.push(row), (row = []), (cur = "");
    else if (ch !== "\r") cur += ch;
  }
  if (cur || row.length) row.push(cur), rows.push(row);
  return rows;
}

const file = process.argv[2];
if (!file) throw new Error("usage: import-medicines <file.csv>");
const text = readFileSync(file, "utf8").replace(/^﻿/, "");
const sep = text.split("\n")[0].includes(";") ? ";" : ",";
const [header, ...rows] = parseCsv(text, sep);
const norm = (s: string) => normalizeMedicineName(s);
const idx = Object.fromEntries(
  Object.entries(COLS).map(([k, names]) => [k, header.findIndex((h) => names.includes(norm(h)))]),
) as Record<keyof typeof COLS, number>;
if (idx.name < 0) throw new Error(`no name column found in: ${header.join(" | ")}`);

const db = createPool(loadConfig().DATABASE_URL);
await tx(db, async (c) => {
  await c.query("TRUNCATE medicines");
  for (const r of rows) {
    const name = r[idx.name]?.trim();
    if (!name) continue;
    const get = (k: keyof typeof COLS) => (idx[k] >= 0 ? r[idx[k]]?.trim() || null : null);
    await c.query("INSERT INTO medicines(name, inn, form, strength, registration_number, normalized) VALUES ($1,$2,$3,$4,$5,$6)", [
      name, get("inn"), get("form"), get("strength"), get("registration_number"), norm(name),
    ]);
  }
});
console.log(`imported ${rows.length} rows`);
await db.end();
