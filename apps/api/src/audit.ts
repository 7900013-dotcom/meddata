import type { Db } from "./db.js";
import type pg from "pg";

export async function audit(
  db: Db | pg.PoolClient,
  actorId: string | null,
  patientId: string | null,
  action: string,
  detail: Record<string, unknown> = {},
) {
  await db.query("INSERT INTO audit_log(actor_id, patient_id, action, detail) VALUES ($1, $2, $3, $4)", [actorId, patientId, action, detail]);
}
