import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { type APIRequestContext, expect } from "@playwright/test";

/**
 * Webhook and mail triggers from the outside (07.6-18): a Standard Webhooks request signed with the secret the page
 * showed, a mail sent to the isolated GreenMail (OCW_E2E_MAIL=1, scripts/e2e-greenmail.sh), and the Keychain item a
 * mailbox signs in with. `standardwebhooks` and `nodemailer` are the API's own pinned packages, resolved from apps/api.
 */

const requireFromApi = createRequire(join(import.meta.dirname, "..", "..", "apps", "api", "package.json"));

type WebhookCtor = new (secret: string) => { sign(id: string, at: Date, body: string): string };

/**
 * POSTs `payload` to a webhook URL, signed with `secret` (or with a throwaway secret when `forge` is set), and answers
 * the status and body. `id` repeats an event (idempotency); `timestamp` moves the clock (the ±5 minute window).
 */
export async function signAndPost(
  url: string,
  secret: string,
  payload: unknown,
  opts: { id?: string; timestamp?: Date; forge?: boolean } = {},
): Promise<{ status: number; body: string; id: string }> {
  const { Webhook } = requireFromApi("standardwebhooks") as { Webhook: WebhookCtor };
  const id = opts.id ?? `msg_${randomUUID()}`;
  const at = opts.timestamp ?? new Date();
  const body = JSON.stringify(payload);
  const key = opts.forge ? `whsec_${Buffer.alloc(32, 7).toString("base64")}` : secret;
  const signature = new Webhook(key).sign(id, at, body);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(Math.floor(at.getTime() / 1000)),
      "webhook-signature": signature,
    },
    body,
  });
  return { status: res.status, body: await res.text(), id };
}

export const SMTP_PORT = Number(process.env.OCW_E2E_SMTP_PORT ?? "4295");
export const IMAP_PORT = Number(process.env.OCW_E2E_IMAP_PORT ?? "4294");
/** The host the API reaches GreenMail by (OCW_EGRESS_TEST_HOSTS maps it to loopback). */
export const MAIL_HOST = "greenmail";
export const mailEnabled = () => process.env.OCW_E2E_MAIL === "1";

/** Sends one plain-text mail to `to` through the isolated GreenMail's SMTP (no TLS, no auth: a test container). */
export async function sendTestMail(
  to: string,
  opts: { subject: string; text: string; from?: string },
): Promise<void> {
  const nodemailer = requireFromApi("nodemailer") as {
    createTransport(o: Record<string, unknown>): {
      sendMail(m: Record<string, unknown>): Promise<unknown>;
      close(): void;
    };
  };
  const transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port: SMTP_PORT,
    secure: false,
    ignoreTLS: true,
  });
  try {
    await transport.sendMail({
      from: opts.from ?? "orders@shop.example",
      to,
      subject: opts.subject,
      text: opts.text,
    });
  } finally {
    transport.close();
  }
}

export interface KeychainItemDto {
  id: string;
  name: string;
  kind: string;
}

/** A personal Keychain `Username & password` item allowed for `hosts` (the caller's own). */
export async function createKeychainBasicItem(
  api: APIRequestContext,
  item: { name: string; hosts: string[]; username: string; password: string },
): Promise<KeychainItemDto> {
  const res = await api.post("/api/v1/keychain", {
    data: {
      kind: "basic",
      scope: "personal",
      name: item.name,
      allowedHosts: item.hosts,
      username: item.username,
      password: item.password,
    },
  });
  expect(res.ok(), `create keychain item ${item.name}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as KeychainItemDto;
}

/** Deletes the caller's personal Keychain items of kind `basic` (so a person starts with none). */
export async function clearBasicKeychainItems(api: APIRequestContext): Promise<void> {
  const res = await api.get("/api/v1/keychain");
  expect(res.ok(), "list keychain").toBe(true);
  const { personal } = (await res.json()) as { personal: KeychainItemDto[] };
  for (const item of personal.filter((i) => i.kind === "basic")) {
    const del = await api.delete(`/api/v1/keychain/${item.id}`);
    expect(del.ok(), `delete keychain item ${item.id}`).toBe(true);
  }
}

export interface WebhookEndpointDto {
  url: string;
  secretSetAt: string;
  previousValidUntil: string | null;
  lastRejectedAt: string | null;
  lastRejectedReason: string | null;
  deliveries: Array<{
    id: string;
    result: string;
    link: { conversationId: string; messageId: string; cardNumber: string | null } | null;
  }>;
}

export async function webhookEndpoint(api: APIRequestContext, id: string): Promise<WebhookEndpointDto> {
  const res = await api.get(`/api/v1/automations/${id}/webhook`);
  expect(res.ok(), `webhook of ${id}: ${res.status()}`).toBe(true);
  return (await res.json()) as WebhookEndpointDto;
}
