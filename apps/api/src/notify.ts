import nodemailer from "nodemailer";
import type { Config } from "./config.js";

export interface Notifier {
  email(to: string, subject: string, text: string): Promise<void>;
  sms(to: string, text: string): Promise<void>;
}

/** Keeps the last messages in memory; used by tests and the dev console transport. */
export class MemoryNotifier implements Notifier {
  sent: { channel: "email" | "sms"; to: string; text: string }[] = [];
  async email(to: string, subject: string, text: string) {
    this.sent.push({ channel: "email", to, text: `${subject}\n${text}` });
  }
  async sms(to: string, text: string) {
    this.sent.push({ channel: "sms", to, text });
  }
  last(to: string) {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
}

export function createNotifier(cfg: Config, log: { info: (o: object, m: string) => void }): Notifier {
  const transport = cfg.EMAIL_TRANSPORT === "smtp" && cfg.SMTP_URL ? nodemailer.createTransport(cfg.SMTP_URL) : null;
  return {
    async email(to, subject, text) {
      if (!transport) return log.info({ to, subject, text }, "email (console transport)");
      await transport.sendMail({ from: cfg.EMAIL_FROM, to, subject, text });
    },
    async sms(to, text) {
      if (cfg.SMS_TRANSPORT !== "http" || !cfg.SMS_HTTP_URL) return log.info({ to, text }, "sms (console transport)");
      const res = await fetch(cfg.SMS_HTTP_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.SMS_HTTP_TOKEN ?? ""}` },
        body: JSON.stringify({ to, text }),
      });
      if (!res.ok) throw new Error(`SMS gateway returned ${res.status}`);
    },
  };
}
