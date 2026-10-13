import { buildApp } from "./app.js";
import { createContext } from "./bootstrap.js";
import { migrate } from "./db.js";

const ctx = createContext();
await migrate(ctx.db);
const app = await buildApp(ctx);
await app.listen({ port: ctx.cfg.PORT, host: "0.0.0.0" });
