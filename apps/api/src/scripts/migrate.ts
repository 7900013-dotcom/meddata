import { loadConfig } from "../config.js";
import { createPool, migrate } from "../db.js";

const db = createPool(loadConfig().DATABASE_URL);
console.log("applied:", await migrate(db));
await db.end();
