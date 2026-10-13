import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { EncryptedStorage } from "./storage.js";
import type { Notifier } from "./notify.js";
import type { Extractor } from "./documents/extract.js";

export interface Ctx {
  cfg: Config;
  db: Db;
  storage: EncryptedStorage;
  notifier: Notifier;
  extractor: Extractor;
}

export type Role = "patient" | "doctor" | "admin";
export interface SessionUser {
  id: string;
  role: Role;
}

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

export type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
