import { loadConfig, type Config } from "./config.js";
import { createPool } from "./db.js";
import { DbBlobStore, DiskBlobStore, EncryptedStorage } from "./storage.js";
import { createNotifier } from "./notify.js";
import { ClaudeExtractor, DemoExtractor } from "./documents/extract.js";
import type { Ctx } from "./context.js";

export function createContext(cfg: Config = loadConfig()): Ctx {
  const db = createPool(cfg.DATABASE_URL);
  return {
    cfg,
    db,
    storage: new EncryptedStorage(cfg.STORAGE_BACKEND === "db" ? new DbBlobStore(db) : new DiskBlobStore(cfg.STORAGE_DIR), cfg.STORAGE_MASTER_KEY),
    notifier: createNotifier(cfg, { info: (o, m) => console.log(m, o) }),
    extractor: cfg.EXTRACTOR === "demo" ? new DemoExtractor() : new ClaudeExtractor(cfg.ANTHROPIC_API_KEY, cfg.CLAUDE_MODEL),
  };
}
