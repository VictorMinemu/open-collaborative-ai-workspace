import { connect, type Socket } from "node:net";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GreenMail, startGreenMail } from "./testing-mail";

/**
 * A minimal line-based IMAP client (no imapflow: plan 07.6-03 installs it in the same wave). `command` sends one
 * tagged command and resolves with everything the server wrote up to and including the tagged completion line.
 */
function imapSession(host: string, port: number) {
  let socket: Socket | undefined;
  let buffer = "";
  let waiter: { test: (b: string) => boolean; resolve: (b: string) => void; reject: (e: Error) => void } | null =
    null;
  const check = () => {
    if (waiter?.test(buffer)) {
      const w = waiter;
      waiter = null;
      const out = buffer;
      buffer = "";
      w.resolve(out);
    }
  };
  const until = (test: (b: string) => boolean) =>
    new Promise<string>((resolve, reject) => {
      waiter = { test, resolve, reject };
      check();
    });
  let counter = 0;
  return {
    open(): Promise<string> {
      const s = connect({ host, port });
      socket = s;
      s.setEncoding("utf8");
      s.on("data", (chunk: string) => {
        buffer += chunk;
        check();
      });
      s.on("error", (e) => waiter?.reject(e));
      return until((b) => /^\* OK/m.test(b));
    },
    command(text: string): Promise<string> {
      counter += 1;
      const tag = `a${counter}`;
      const done = until((b) => new RegExp(`^${tag} (OK|NO|BAD)`, "m").test(b));
      socket?.write(`${tag} ${text}\r\n`);
      return done;
    },
    close() {
      socket?.destroy();
    },
  };
}

describe("startGreenMail (07.6-04, D-02 / P-20)", () => {
  let mail: GreenMail;

  beforeAll(async () => {
    mail = await startGreenMail({ users: ["ops@acme.test"] });
  });

  afterAll(async () => {
    await mail?.stop().catch(() => undefined);
  });

  it("returns loopback ports and one login per requested user", () => {
    expect(mail.host).toBe("127.0.0.1");
    for (const port of [mail.imapPort, mail.imapsPort, mail.smtpPort]) expect(port).toBeGreaterThan(0);
    expect(mail.users).toHaveLength(1);
    expect(mail.users[0]).toMatchObject({ address: "ops@acme.test", login: "ops@acme.test" });
    expect(mail.users[0]?.password.length).toBeGreaterThanOrEqual(16);
  });

  it("a mail injected over SMTP with chosen headers is readable over IMAP", async () => {
    await mail.sendMail({
      from: "orders@shop.test",
      to: "ops@acme.test",
      subject: "Order 1001",
      text: "Deliver before noon",
      messageId: "<m1@shop.test>",
      headers: { "Auto-Submitted": "auto-replied" },
    });
    const user = mail.users[0];
    if (!user) throw new Error("no user");
    const imap = imapSession(mail.host, mail.imapPort);
    try {
      expect(await imap.open()).toMatch(/^\* OK/m);
      expect(await imap.command(`LOGIN "${user.login}" "${user.password}"`)).toMatch(/^a1 OK/m);
      // GreenMail delivers before the SMTP reply, but allow a short settle for the INBOX to show it.
      let select = "";
      for (let i = 0; i < 20; i += 1) {
        select = await imap.command("SELECT INBOX");
        if (/^\* 1 EXISTS/m.test(select)) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(select).toMatch(/^\* 1 EXISTS/m);
      const fetched = await imap.command("FETCH 1 BODY.PEEK[HEADER]");
      expect(fetched).toMatch(/^a\d+ OK/m);
      expect(fetched).toMatch(/^Message-ID: <m1@shop\.test>/im);
      expect(fetched).toMatch(/^Auto-Submitted: auto-replied/im);
      expect(fetched).toMatch(/^Subject: Order 1001/im);
    } finally {
      imap.close();
    }
  });

  it("refuses a wrong password (auth is on, so a test proves its own login)", async () => {
    const imap = imapSession(mail.host, mail.imapPort);
    try {
      await imap.open();
      expect(await imap.command(`LOGIN "ops@acme.test" "wrong-password"`)).toMatch(/^a1 NO/m);
    } finally {
      imap.close();
    }
  });

  it("stop() removes the container", async () => {
    const id = mail.containerId;
    await mail.stop();
    const client = await getContainerRuntimeClient();
    const all = await client.container.list();
    expect(all.some((c) => c.Id === id)).toBe(false);
  });
});
