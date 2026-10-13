import type { Db } from "../db.js";
import { many, one } from "../db.js";
import type { Medicine } from "../documents/schema.js";

export type MedicineCheck =
  | { name: string; status: "matched"; register_name: string; registration_number: string | null }
  | { name: string; status: "similar"; suggestions: string[] }
  | { name: string; status: "not_found" }
  | { name: string; status: "register_not_loaded" };

/** Lowercase, strip diacritics, dosage and punctuation: "Amoxicilină 500mg" -> "amoxicilina". */
export function normalizeMedicineName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\[\?\]/g, "")
    .replace(/\d+([.,]\d+)?\s*(mg|g|ml|mcg|µg|ui|iu|%)\b/g, "")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Checks medicine names read from a prescription against Moldova's medicines
 * register (AMDM nomenclator). A name that isn't an exact match is flagged for
 * the patient to confirm; it is never silently corrected.
 */
export async function checkMedicines(db: Db, medicines: Pick<Medicine, "name">[]): Promise<MedicineCheck[]> {
  if (medicines.length === 0) return [];
  const loaded = await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM (SELECT 1 FROM medicines LIMIT 1) t");
  if (!loaded?.n) return medicines.map((m) => ({ name: m.name, status: "register_not_loaded" as const }));

  const out: MedicineCheck[] = [];
  for (const m of medicines) {
    const norm = normalizeMedicineName(m.name);
    const firstWord = norm.split(" ")[0] ?? "";
    const exact = await one<{ name: string; registration_number: string | null }>(
      db,
      `SELECT name, registration_number FROM medicines
        WHERE normalized = $1 OR split_part(normalized, ' ', 1) = $2 OR lower(inn) = $2 LIMIT 1`,
      [norm, firstWord],
    );
    if (exact) {
      out.push({ name: m.name, status: "matched", register_name: exact.name, registration_number: exact.registration_number });
      continue;
    }
    const similar = await many<{ name: string }>(
      db,
      `SELECT name FROM (SELECT DISTINCT ON (normalized) name, similarity(normalized, $1) AS s FROM medicines
         WHERE normalized % $1 ORDER BY normalized, s DESC) t ORDER BY s DESC LIMIT 5`,
      [norm],
    );
    out.push(similar.length ? { name: m.name, status: "similar", suggestions: similar.map((r) => r.name) } : { name: m.name, status: "not_found" });
  }
  return out;
}
