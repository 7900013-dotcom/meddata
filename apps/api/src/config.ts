import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  PUBLIC_URL: z.string().default("http://localhost:5173"),
  API_URL: z.string().default("http://localhost:4000"),
  DATABASE_URL: z.string().default("postgres://meddata:meddata@localhost:5432/meddata"),
  SESSION_SECRET: z.string().min(32).default("dev-only-session-secret-change-me-0123456789"),
  // 32 bytes, base64. Wraps the per-file keys that encrypt every stored original.
  STORAGE_MASTER_KEY: z.string().default("ZGV2LW9ubHktbWFzdGVyLWtleS1jaGFuZ2UtbWUhISE="),
  STORAGE_DIR: z.string().default("./data/files"),

  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default("claude-opus-5-5"),
  // "demo" returns a fixed sample reading so the app can be tried without an Anthropic API key.
  EXTRACTOR: z.enum(["claude", "demo"]).default("claude"),

  EMAIL_TRANSPORT: z.enum(["console", "smtp"]).default("console"),
  SMTP_URL: z.string().optional(),
  EMAIL_FROM: z.string().default("MedData <no-reply@meddata.local>"),
  SMS_TRANSPORT: z.enum(["console", "http"]).default("console"),
  // Generic HTTP SMS gateway: POST JSON {to, text} with a bearer token.
  SMS_HTTP_URL: z.string().optional(),
  SMS_HTTP_TOKEN: z.string().optional(),

  // MPass (Moldova e-government identity, SAML 2.0). "mock" serves a local login form for development.
  MPASS_MODE: z.enum(["mock", "saml"]).default("mock"),
  MPASS_ENTRY_POINT: z.string().optional(),
  MPASS_LOGOUT_URL: z.string().optional(),
  MPASS_ISSUER: z.string().default("meddata"),
  MPASS_IDP_CERT: z.string().optional(),
  MPASS_SP_PRIVATE_KEY: z.string().optional(),
  MPASS_SP_CERT: z.string().optional(),
  // Attribute names returned by MPass. Verify against the MPass integration guide from AGE.
  MPASS_ATTR_IDNP: z.string().default("nameID"),
  MPASS_ATTR_FIRST_NAME: z.string().default("FirstName"),
  MPASS_ATTR_LAST_NAME: z.string().default("LastName"),
  MPASS_ATTR_EMAIL: z.string().default("EmailAddress"),

  OTP_TTL_MINUTES: z.coerce.number().default(10),
  SHARE_TOKEN_TTL_MINUTES: z.coerce.number().default(15),
  ACCESS_REQUEST_TTL_MINUTES: z.coerce.number().default(30),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(overrides: Partial<Record<keyof Config, unknown>> = {}): Config {
  const cfg = Env.parse({ ...process.env, ...overrides });
  if (cfg.NODE_ENV === "production") {
    if (cfg.MPASS_MODE === "mock") throw new Error("MPASS_MODE=mock is not allowed in production");
    if (cfg.EXTRACTOR === "demo") throw new Error("EXTRACTOR=demo is not allowed in production");
    if (cfg.SESSION_SECRET.startsWith("dev-only")) throw new Error("Set SESSION_SECRET in production");
    if (cfg.STORAGE_MASTER_KEY === Env.shape.STORAGE_MASTER_KEY.parse(undefined))
      throw new Error("Set STORAGE_MASTER_KEY in production");
  }
  if (Buffer.from(cfg.STORAGE_MASTER_KEY, "base64").length !== 32)
    throw new Error("STORAGE_MASTER_KEY must be 32 bytes, base64-encoded");
  return cfg;
}
