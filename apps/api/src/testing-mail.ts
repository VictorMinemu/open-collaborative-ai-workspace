import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import nodemailer from "nodemailer";
import { GenericContainer, type StartedTestContainer } from "testcontainers";

// Test-only (07.6-04, D-02 / P-20): a disposable GreenMail for IMAP integration tests. Imported by `*.int.test.ts`
// only; no real mail server is ever used. scripts/e2e-greenmail.sh runs the same pinned image for the e2e stack.

/** Apache-2.0, pinned by digest (same pin as scripts/e2e-greenmail.sh). */
export const GREENMAIL_IMAGE =
  "greenmail/standalone:2.1.14@sha256:1ef95a966418cd09b7ea91d504d8c0826bbe7a2f6e679a75c601a831587c1626";

/** `-Dgreenmail.setup.test.all` ports inside the container. */
const SMTP = 3025;
const IMAP = 3143;
const IMAPS = 3993;
const HOST = "127.0.0.1";

export interface GreenMailUser {
  address: string;
  /** The full address (`greenmail.users.login=email`). */
  login: string;
  /** Random per run. */
  password: string;
}

export interface GreenMailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** e.g. `<m1@shop.test>`; nodemailer generates one when absent. */
  messageId?: string;
  /** Extra headers (Auto-Submitted, In-Reply-To, References, List-Id, …). */
  headers?: Record<string, string>;
}

export interface GreenMail {
  host: string;
  imapPort: number;
  /** IMAP over TLS with GreenMail's self-signed certificate. */
  imapsPort: number;
  smtpPort: number;
  users: GreenMailUser[];
  containerId: string;
  container: StartedTestContainer;
  /** Injects one message over plain SMTP (test container only, no TLS, no auth). */
  sendMail(message: GreenMailMessage): Promise<void>;
  /** Stops and removes the container. */
  stop(): Promise<void>;
}

const ADDRESS = /^([A-Za-z0-9._+-]+)@([A-Za-z0-9.-]+)$/;

/** Resolves once the server greets with `* OK` (GreenMail opens its ports before it answers on them). */
async function waitForImapGreeting(port: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: HOST, port });
      let data = "";
      const done = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(2_000, () => done(false));
      socket.on("data", (chunk) => {
        data += chunk.toString("utf8");
        if (data.includes("\r\n")) done(data.startsWith("* OK"));
      });
      socket.on("error", () => done(false));
      socket.on("close", () => done(false));
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error("GreenMail: no IMAP greeting");
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** A throwaway GreenMail (SMTP + IMAP + IMAPS) with one account per address in `users` (default `ops@acme.test`). */
export async function startGreenMail(o: { users?: string[] } = {}): Promise<GreenMail> {
  const addresses = o.users ?? ["ops@acme.test"];
  const users = addresses.map((address) => {
    if (!ADDRESS.test(address)) throw new Error(`startGreenMail: not a plain address: ${address}`);
    return { address, login: address, password: randomBytes(12).toString("hex") };
  });
  // `local:password@domain`; with users.login=email the login is the whole address.
  const userList = users
    .map((u) => {
      const [, local, domain] = ADDRESS.exec(u.address) ?? [];
      return `${local}:${u.password}@${domain}`;
    })
    .join(",");
  const container = await new GenericContainer(GREENMAIL_IMAGE)
    .withEnvironment({
      GREENMAIL_OPTS: [
        "-Dgreenmail.setup.test.all",
        "-Dgreenmail.hostname=0.0.0.0",
        `-Dgreenmail.users=${userList}`,
        "-Dgreenmail.users.login=email",
      ].join(" "),
    })
    .withExposedPorts(SMTP, IMAP, IMAPS)
    .start();
  const smtpPort = container.getMappedPort(SMTP);
  const imapPort = container.getMappedPort(IMAP);
  const imapsPort = container.getMappedPort(IMAPS);
  try {
    await waitForImapGreeting(imapPort);
  } catch (error) {
    await container.stop().catch(() => undefined);
    throw error;
  }
  const transport = nodemailer.createTransport({
    host: HOST,
    port: smtpPort,
    secure: false,
    ignoreTLS: true,
  });
  let stopped = false;
  return {
    host: HOST,
    imapPort,
    imapsPort,
    smtpPort,
    users,
    containerId: container.getId(),
    container,
    async sendMail(m) {
      await transport.sendMail({
        from: m.from,
        to: m.to,
        subject: m.subject,
        text: m.text,
        ...(m.html !== undefined ? { html: m.html } : {}),
        ...(m.messageId !== undefined ? { messageId: m.messageId } : {}),
        ...(m.headers ? { headers: m.headers } : {}),
      });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      transport.close();
      await container.stop();
    },
  };
}
