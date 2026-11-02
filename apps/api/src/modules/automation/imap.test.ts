import type { ImapFlowOptions, MailboxObject } from "imapflow";
import { describe, expect, it, vi } from "vitest";
import { EgressRefusedError, type EgressResolver } from "../../lib/egress";
import {
  type ImapClient,
  imapOptionsFor,
  mailErrorCode,
  mailHostAllowed,
  readNewMail,
  tryMailbox,
  uidKey,
  withMailbox,
} from "./imap";

/**
 * 07.6-11 (D-07, P-17, A3): the IMAP client side without a server. Options are pinned and verified, the folder is
 * opened read-only and fetched with PEEK only, sessions always end, failures become fixed codes. A spy stands in for
 * ImapFlow and a stub for the egress resolver.
 */

const creds = { username: "ops@acme.com", password: "s3cret-Pa55" };

describe("imapOptionsFor: pinned address, TLS verified against the host name, no logger", () => {
  it("a real host: implicit TLS to the pinned IP with the host as SNI and certificate name", () => {
    const o = imapOptionsFor({
      pinned: { address: "198.51.100.7" },
      host: "imap.acme.com",
      port: 993,
      testHost: false,
      ...creds,
    });
    expect(o).toMatchObject({
      host: "198.51.100.7",
      port: 993,
      servername: "imap.acme.com",
      secure: true,
      tls: { rejectUnauthorized: true, servername: "imap.acme.com" },
      logger: false,
      emitLogs: false,
      auth: { user: "ops@acme.com", pass: "s3cret-Pa55" },
    });
  });

  it("an IP literal host is verified as itself (no SNI name)", () => {
    const o = imapOptionsFor({
      pinned: { address: "8.8.4.4" },
      host: "8.8.4.4",
      port: 993,
      testHost: false,
      ...creds,
    });
    expect(o.servername).toBeUndefined();
    expect(o).toMatchObject({
      host: "8.8.4.4",
      secure: true,
      tls: { rejectUnauthorized: true },
      logger: false,
    });
  });

  it("plain IMAP only for a test host, without STARTTLS", () => {
    const o = imapOptionsFor({
      pinned: { address: "127.0.0.1" },
      host: "greenmail",
      port: 3143,
      testHost: true,
      ...creds,
    });
    expect(o).toMatchObject({ host: "127.0.0.1", secure: false, doSTARTTLS: false, logger: false });
  });

  it("never an option that disables verification, for any input", () => {
    for (const host of ["imap.acme.com", "10.0.0.5", "mail.lan", "greenmail"]) {
      for (const testHost of [false, true]) {
        const o = imapOptionsFor({ pinned: { address: "10.0.0.5" }, host, port: 993, testHost, ...creds });
        expect(JSON.stringify(o)).not.toContain('"rejectUnauthorized":false');
        expect(o.logger).toBe(false);
        if (!testHost) expect(o.secure).toBe(true);
      }
    }
  });
});

describe("mailHostAllowed: the Keychain item's hosts for IMAP", () => {
  it("exact host with its port; no port means 993; wildcards cover strict subdomains only", () => {
    expect(mailHostAllowed(["imap.acme.com"], "imap.acme.com", 993)).toBe(true);
    expect(mailHostAllowed(["imap.acme.com"], "imap.acme.com", 143)).toBe(false);
    expect(mailHostAllowed(["imap.acme.com:143"], "imap.acme.com", 143)).toBe(true);
    expect(mailHostAllowed(["*.acme.com"], "imap.acme.com", 993)).toBe(true);
    expect(mailHostAllowed(["*.acme.com"], "acme.com", 993)).toBe(false);
    expect(mailHostAllowed(["acme.com"], "imap.acme.com", 993)).toBe(false);
    expect(mailHostAllowed(["imap.acme.com"], "imap.acme.com.evil.example", 993)).toBe(false);
    expect(mailHostAllowed(["greenmail:3143"], "GreenMail", 3143)).toBe(true);
  });
});

describe("mailErrorCode: fixed codes, never the server's text", () => {
  it("maps sign-in, folder, certificate, network and egress failures", () => {
    expect(mailErrorCode(Object.assign(new Error("x"), { authenticationFailed: true }))).toBe("auth_failed");
    expect(mailErrorCode(Object.assign(new Error("x"), { serverResponseCode: "AUTHENTICATIONFAILED" }))).toBe(
      "auth_failed",
    );
    expect(mailErrorCode(Object.assign(new Error("x"), { mailboxMissing: true }))).toBe("folder_missing");
    expect(mailErrorCode(Object.assign(new Error("x"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }))).toBe(
      "certificate",
    );
    expect(mailErrorCode(Object.assign(new Error("x"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }))).toBe(
      "certificate",
    );
    expect(
      mailErrorCode(
        Object.assign(new Error("x"), { _err: Object.assign(new Error("y"), { code: "CERT_HAS_EXPIRED" }) }),
      ),
    ).toBe("certificate");
    expect(mailErrorCode(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe("unreachable");
    expect(mailErrorCode(Object.assign(new Error("x"), { code: "GREETING_TIMEOUT" }))).toBe("unreachable");
    expect(mailErrorCode(new EgressRefusedError("private_address", "mail.lan"))).toBe("unreachable");
    expect(mailErrorCode(new Error("something else"))).toBe("unknown");
    expect(mailErrorCode(null)).toBe("unknown");
  });
});

// ---------------------------------------------------------------- the spy client

interface Spy {
  client: ImapClient;
  options: ImapFlowOptions[];
  calls: Array<{ name: string; args: unknown[] }>;
}

function box(p: Partial<MailboxObject> = {}): MailboxObject {
  return { path: "INBOX", uidValidity: 42n, uidNext: 11, exists: 10, ...p } as MailboxObject;
}

/** A spy ImapFlow: messages by UID; records every call. */
function spyClient(
  p: {
    mailbox?: MailboxObject;
    uids?: number[];
    connectError?: unknown;
    lockError?: unknown;
    sources?: Record<number, string>;
  } = {},
): Spy {
  const calls: Spy["calls"] = [];
  const options: ImapFlowOptions[] = [];
  const record = (name: string, ...args: unknown[]) => calls.push({ name, args });
  const uids = p.uids ?? [];
  const client = {
    mailbox: p.mailbox ?? box(),
    on: vi.fn((...args: unknown[]) => {
      record("on", ...args);
      return client;
    }),
    async connect() {
      record("connect");
      if (p.connectError) throw p.connectError;
    },
    async logout() {
      record("logout");
    },
    close() {
      record("close");
    },
    async getMailboxLock(path: string, opts: unknown) {
      record("getMailboxLock", path, opts);
      if (p.lockError) throw p.lockError;
      return { path, release: () => record("release") };
    },
    async search(query: unknown, opts: unknown) {
      record("search", query, opts);
      const q = query as { uid?: string; all?: boolean };
      if (q.all) return uids;
      const from = Number(q.uid?.split(":")[0]);
      const hits = uids.filter((u) => u >= from);
      // IMAP `n:*` with nothing at or above n still returns the newest message.
      return hits.length > 0 ? hits : uids.slice(-1);
    },
    async *fetch(range: string, query: unknown, opts: unknown) {
      record("fetch", range, query, opts);
      for (const uid of range.split(",").map(Number)) {
        yield {
          seq: uid,
          uid,
          source: Buffer.from(p.sources?.[uid] ?? `Message-ID: <${uid}@x>\r\n\r\nbody`),
        };
      }
    },
  } as unknown as ImapClient;
  return { client, options, calls };
}

const egress = (address = "198.51.100.7", testHost = false) => {
  const resolve = vi.fn(async () => ({ address, family: 4 as const, testHost }));
  return { resolver: { resolve } as EgressResolver, resolve };
};

const target = { host: "imap.acme.com", port: 993, folder: "Orders", ...creds, privateAllow: ["x:993"] };

describe("withMailbox: pinned, read-only, always logged out", () => {
  it("resolves through the egress guard, connects to the pinned address, EXAMINEs the folder", async () => {
    const spy = spyClient();
    const { resolver, resolve } = egress();
    const out = await withMailbox(
      resolver,
      target,
      async (_c, b) => b.exists,
      (o) => {
        spy.options.push(o);
        return spy.client;
      },
    );
    expect(out).toBe(10);
    expect(resolve).toHaveBeenCalledWith("imap.acme.com", {
      port: 993,
      privateAllow: ["x:993"],
      timeoutMs: 10_000,
    });
    expect(spy.options[0]).toMatchObject({
      host: "198.51.100.7",
      servername: "imap.acme.com",
      secure: true,
      logger: false,
    });
    const lock = spy.calls.find((c) => c.name === "getMailboxLock");
    expect(lock?.args).toEqual(["Orders", { readOnly: true }]);
    expect(spy.calls.map((c) => c.name)).toEqual(["on", "connect", "getMailboxLock", "release", "logout"]);
  });

  it("logs out (and releases the lock) when the work throws", async () => {
    const spy = spyClient();
    await expect(
      withMailbox(
        egress().resolver,
        target,
        async () => {
          throw new Error("boom");
        },
        () => spy.client,
      ),
    ).rejects.toThrow("boom");
    expect(spy.calls.map((c) => c.name)).toEqual(["on", "connect", "getMailboxLock", "release", "logout"]);
  });

  it("an egress refusal connects nothing", async () => {
    const factory = vi.fn();
    const resolver = {
      resolve: vi.fn(async () => {
        throw new EgressRefusedError("private_address", "imap.acme.com");
      }),
    } as EgressResolver;
    expect(await tryMailbox(resolver, target, factory)).toEqual({ ok: false, code: "unreachable" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("a folder the server refuses is folder_missing; a refused sign-in is auth_failed", async () => {
    const folder = spyClient({ lockError: Object.assign(new Error("NO"), { responseStatus: "NO" }) });
    expect(await tryMailbox(egress().resolver, target, () => folder.client)).toEqual({
      ok: false,
      code: "folder_missing",
    });
    expect(folder.calls.at(-1)?.name).toBe("logout");
    const auth = spyClient({ connectError: Object.assign(new Error("NO"), { authenticationFailed: true }) });
    expect(await tryMailbox(egress().resolver, target, () => auth.client)).toEqual({
      ok: false,
      code: "auth_failed",
    });
    expect(auth.calls.at(-1)?.name).toBe("logout");
  });
});

describe("readNewMail: only mail above the cursor, by UID, with PEEK", () => {
  it("fetches UIDs above lastUid by UID with a capped source and no flag change", async () => {
    const spy = spyClient({ uids: [3, 7, 9, 10] });
    const r = await readNewMail(spy.client, box(), { uidValidity: 42, lastUid: 7 });
    expect(r).toMatchObject({ uidValidity: 42, lastUid: 10, baseline: false, more: false });
    expect(r.mails.map((m) => m.uid)).toEqual([9, 10]);
    const fetch = spy.calls.find((c) => c.name === "fetch");
    expect(fetch?.args).toEqual(["9,10", { uid: true, source: { maxLength: 262_144 } }, { uid: true }]);
    const query = fetch?.args[1] as Record<string, unknown>;
    expect(Object.keys(query).sort()).toEqual(["source", "uid"]);
    expect(query).not.toHaveProperty("markSeen");
    expect(spy.calls.map((c) => c.name)).not.toContain("messageFlagsAdd");
  });

  it("`n:*` returning the newest old message reads nothing", async () => {
    const spy = spyClient({ uids: [5] });
    const r = await readNewMail(spy.client, box({ uidNext: 9 }), { uidValidity: 42, lastUid: 7 });
    expect(spy.calls.map((c) => c.name)).toEqual(["search"]);
    expect(r.mails).toEqual([]);
    expect(r.lastUid).toBe(7);
  });

  it("nothing above UIDNEXT − 1 skips the search", async () => {
    const spy = spyClient({ uids: [1, 2] });
    const r = await readNewMail(spy.client, box({ uidNext: 3 }), { uidValidity: 42, lastUid: 2 });
    expect(r.mails).toEqual([]);
    expect(spy.calls.map((c) => c.name)).toEqual([]);
  });

  it("caps a poll and says more is waiting", async () => {
    const uids = Array.from({ length: 8 }, (_, i) => i + 1);
    const spy = spyClient({ uids });
    const r = await readNewMail(spy.client, box({ uidNext: 9 }), { uidValidity: 42, lastUid: 0 }, 3);
    expect(r.mails.map((m) => m.uid)).toEqual([1, 2, 3]);
    expect(r).toMatchObject({ lastUid: 3, more: true });
  });

  it("a first read or a changed UIDVALIDITY only moves the cursor to the newest message", async () => {
    const first = await readNewMail(spyClient().client, box(), { uidValidity: null, lastUid: null });
    expect(first).toMatchObject({ baseline: true, validityChanged: false, lastUid: 10, mails: [] });
    const changed = await readNewMail(spyClient().client, box({ uidValidity: 43n }), {
      uidValidity: 42,
      lastUid: 9,
    });
    expect(changed).toMatchObject({
      baseline: true,
      validityChanged: true,
      uidValidity: 43,
      lastUid: 10,
      mails: [],
    });
    const noNext = spyClient({ uids: [4, 12] });
    const fallback = await readNewMail(noNext.client, box({ uidNext: undefined as unknown as number }), {
      uidValidity: null,
      lastUid: null,
    });
    expect(fallback.lastUid).toBe(12);
  });

  it("uidKey hashes UIDVALIDITY and UID", () => {
    expect(uidKey(42, 7)).toMatch(/^uid:[0-9a-f]{64}$/);
    expect(uidKey(42, 7)).not.toBe(uidKey(43, 7));
    expect(uidKey(42, 7)).toBe(uidKey(42, 7));
  });
});
