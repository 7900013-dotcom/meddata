import { SignJWT, jwtVerify } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { HttpError, type Role, type SessionUser } from "../context.js";

export const COOKIE = "md_session";
const TTL_HOURS: Record<Role, number> = { patient: 24 * 7, doctor: 12, admin: 8 };

export class Sessions {
  private key: Uint8Array;
  constructor(secret: string, private secure: boolean) {
    this.key = new TextEncoder().encode(secret);
  }

  async issue(reply: FastifyReply, user: SessionUser) {
    const hours = TTL_HOURS[user.role];
    const jwt = await new SignJWT({ role: user.role })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime(`${hours}h`)
      .sign(this.key);
    reply.setCookie(COOKIE, jwt, { httpOnly: true, sameSite: "lax", secure: this.secure, path: "/", maxAge: hours * 3600 });
  }

  clear(reply: FastifyReply) {
    reply.clearCookie(COOKIE, { path: "/" });
  }

  async read(req: FastifyRequest): Promise<SessionUser | null> {
    const token = req.cookies[COOKIE];
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ["HS256"] });
      return { id: String(payload.sub), role: payload.role as Role };
    } catch {
      return null;
    }
  }
}

export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest) => {
    if (!req.user) throw new HttpError(401, "not_signed_in");
    if (!roles.includes(req.user.role)) throw new HttpError(403, "wrong_role");
  };
}
