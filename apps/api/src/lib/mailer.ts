import nodemailer from "nodemailer";
import type { Env } from "../config/env";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Outbound e-mail port. SMTP is optional (AUTH-04): without OCW_SMTP_URL there is no mailer and admins
 * issue password reset links instead. Message bodies carry reset links, so they are never logged.
 */
export interface Mailer {
  readonly kind: "smtp" | "memory";
  send(message: MailMessage): Promise<void>;
}

const outbox: MailMessage[] = [];

/** Test-only: messages sent through the `memory:` mailer (loadEnv rejects `memory:` outside NODE_ENV=test). */
export function memoryOutbox(): MailMessage[] {
  return outbox.map((m) => ({ ...m }));
}

export function clearMemoryOutbox(): void {
  outbox.length = 0;
}

const memoryMailer: Mailer = {
  kind: "memory",
  async send(message) {
    outbox.push({ ...message });
  },
};

export function createMailer(env: Pick<Env, "OCW_SMTP_URL" | "OCW_MAIL_FROM">): Mailer | null {
  if (!env.OCW_SMTP_URL) return null;
  if (env.OCW_SMTP_URL === "memory:") return memoryMailer;
  const transport = nodemailer.createTransport(env.OCW_SMTP_URL);
  return {
    kind: "smtp",
    async send(message) {
      await transport.sendMail({ from: env.OCW_MAIL_FROM, ...message });
    },
  };
}
