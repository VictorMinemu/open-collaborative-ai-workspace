import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { AUTOMATION_LIMITS, type MailboxTestResult } from "@ocw/contracts";
import { ImapFlow, type ImapFlowOptions, type MailboxObject } from "imapflow";
import { EgressRefusedError, type EgressResolver, resolveEgressAddress } from "../../lib/egress";

/**
 * The IMAP client side of a mail trigger (07.6-11; AUTO-02, D-02, D-07, R8, P-17; research Pattern 5, A3). Nothing here
 * reads the database: `mailboxes.ts` hands in the Keychain credentials, the host and the private allowance.
 *
 * - The host is resolved once through the egress guard (`resolveEgressAddress`: the same platform, loopback, metadata
 *   and private-address refusals as every HTTP egress) and the client connects to that pinned address only.
 * - Implicit TLS for every real host, verified against the configured host name (`servername`, Node's hostname check)
 *   with `rejectUnauthorized: true`. Plain IMAP exists only for `OCW_EGRESS_TEST_HOSTS` names (tests, never production).
 * - ImapFlow's logger is always off: its debug output carries the LOGIN exchange.
 * - Read-only toward the user's mailbox: the folder is opened with `readOnly: true` (EXAMINE) and messages are fetched
 *   with BODY.PEEK; nothing here stores flags, copies, moves or expunges.
 * - Failures become fixed codes; no server text is kept.
 */

export type MailboxErrorCode = Extract<MailboxTestResult, { ok: false }>["code"];

/** Connection budgets (the API waits for the baseline after a save and the test route answers inline). */
export const IMAP_TIMEOUTS = { connectMs: 10_000, greetingMs: 10_000, socketMs: 30_000 } as const;
/**
 * The whole session's deadline (resolve, connect, sign in, EXAMINE, SEARCH, FETCH): the idle-socket timeout alone never
 * fires against a server that answers one byte every few seconds (07.6 review A HI-01).
 */
export const IMAP_SESSION_MS = 60_000;

/** A session ended by its deadline or by the job's signal: `unreachable` (its code is a network timeout's). */
class SessionAborted extends Error {
  readonly code = "ETIMEOUT";
  constructor() {
    super("mail session ended (deadline or shutdown)");
    this.name = "SessionAborted";
  }
}

export interface SessionOptions {
  /** The job's signal: pg-boss aborts it when it gives up on the job or shuts down. */
  signal?: AbortSignal;
  /** The whole session's deadline (default `IMAP_SESSION_MS`). */
  deadlineMs?: number;
}
/** New mails read per poll; more wait for the next minute's tick. */
export const MAX_MAILS_PER_POLL = 50;
/** The IMAPS port a host pattern without a port stands for. */
const IMAPS_PORT = 993;

/**
 * True when a Keychain item's allowed hosts admit `host:port` for IMAP: the host equals a pattern's host or is a strict
 * subdomain of a `*.` pattern, and the port is the pattern's (993 when the pattern names none).
 */
export function mailHostAllowed(patterns: readonly string[], host: string, port: number): boolean {
  const h = host.trim().toLowerCase();
  return patterns.some((raw) => {
    const m = /^(\*\.)?([a-z0-9.-]{1,253})(?::(\d{1,5}))?$/.exec(raw.trim().toLowerCase());
    if (!m?.[2]) return false;
    if ((m[3] ? Number(m[3]) : IMAPS_PORT) !== port) return false;
    return m[1] ? h.endsWith(`.${m[2]}`) : h === m[2];
  });
}

/**
 * ImapFlow options for one connection to a pinned address. Real hosts: implicit TLS, the configured host as SNI and
 * certificate name (an IP literal is checked as itself), verification never disabled. Test hosts: plain IMAP, no
 * STARTTLS. Never a logger.
 */
export function imapOptionsFor(p: {
  pinned: { address: string };
  host: string;
  port: number;
  testHost: boolean;
  username: string;
  password: string;
}): ImapFlowOptions {
  const literal = isIP(p.host) !== 0;
  const common = {
    host: p.pinned.address,
    port: p.port,
    auth: { user: p.username, pass: p.password },
    logger: false as const,
    emitLogs: false,
    disableAutoIdle: true,
    disableCompression: true,
    connectionTimeout: IMAP_TIMEOUTS.connectMs,
    greetingTimeout: IMAP_TIMEOUTS.greetingMs,
    socketTimeout: IMAP_TIMEOUTS.socketMs,
  };
  if (p.testHost) return { ...common, secure: false, doSTARTTLS: false };
  return {
    ...common,
    secure: true,
    ...(literal ? {} : { servername: p.host }),
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2", ...(literal ? {} : { servername: p.host }) },
  };
}

// ---------------------------------------------------------------- errors

const CERT_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
]);

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "NoConnection",
  "EConnectionClosed",
  "ClosedAfterConnectText",
  "ClosedAfterConnectTLS",
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
  "ETIMEOUT",
]);

interface ErrorFacts {
  code?: unknown;
  authenticationFailed?: unknown;
  mailboxMissing?: unknown;
  serverResponseCode?: unknown;
  tlsFailed?: unknown;
  cause?: unknown;
  _err?: unknown;
}

/** The fixed code of a connection, sign-in or folder failure (the error chain is walked; no message is read). */
export function mailErrorCode(err: unknown): MailboxErrorCode {
  const chain: ErrorFacts[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur && typeof cur === "object"; depth++) {
    chain.push(cur as ErrorFacts);
    const next = (cur as ErrorFacts).cause ?? (cur as ErrorFacts)._err;
    cur = next === cur ? null : next;
  }
  if (chain.some((e) => e instanceof EgressRefusedError)) return "unreachable";
  if (chain.some((e) => e.authenticationFailed === true || e.serverResponseCode === "AUTHENTICATIONFAILED"))
    return "auth_failed";
  if (chain.some((e) => e.mailboxMissing === true || e.serverResponseCode === "NONEXISTENT"))
    return "folder_missing";
  const codes = chain.map((e) => (typeof e.code === "string" ? e.code : ""));
  if (codes.some((c) => CERT_CODES.has(c) || /^ERR_TLS_CERT|CERT_/.test(c))) return "certificate";
  if (codes.some((c) => NETWORK_CODES.has(c)) || chain.some((e) => e.tlsFailed === true))
    return "unreachable";
  return "unknown";
}

/** A folder the server would not open read-only (after a good sign-in): `folder_missing`. */
class FolderError extends Error {
  readonly mailboxMissing = true;
  constructor() {
    super("folder not available");
    this.name = "FolderError";
  }
}

// ---------------------------------------------------------------- connection

/** Where to connect and as whom (Keychain only, R8); `privateAllow` is the admin's allowance for a unit item. */
export interface MailboxTarget {
  host: string;
  port: number;
  folder: string;
  username: string;
  password: string;
  privateAllow: readonly string[];
}

/** The ImapFlow surface the poller uses (a seam for unit tests). */
export type ImapClient = Pick<
  ImapFlow,
  "connect" | "logout" | "close" | "getMailboxLock" | "search" | "fetch" | "mailbox" | "on"
>;
export type ImapClientFactory = (options: ImapFlowOptions) => ImapClient;

const defaultClient: ImapClientFactory = (options) => new ImapFlow(options);

/**
 * Resolves the host through the egress guard, connects to the pinned address, signs in, opens `folder` read-only
 * (EXAMINE) and runs `fn`; the lock is released and the session logged out in every case. The whole session ends at
 * its deadline or when `opts.signal` aborts: the socket is closed and the call rejects as `unreachable`, so a slow or
 * hostile server never holds a worker (07.6 review A HI-01).
 */
export async function withMailbox<T>(
  egress: EgressResolver,
  target: MailboxTarget,
  fn: (client: ImapClient, box: MailboxObject) => Promise<T>,
  createClient: ImapClientFactory = defaultClient,
  opts: SessionOptions = {},
): Promise<T> {
  const deadline = AbortSignal.timeout(opts.deadlineMs ?? IMAP_SESSION_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  if (signal.aborted) throw new SessionAborted();
  const live: { client: ImapClient | null } = { client: null };
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(new SessionAborted());
      try {
        live.client?.close();
      } catch {
        // Already closed.
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const work = session(egress, target, fn, createClient, live, signal);
  // Whichever loses the race settles later; neither may become an unhandled rejection.
  work.catch(() => {});
  aborted.catch(() => {});
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function session<T>(
  egress: EgressResolver,
  target: MailboxTarget,
  fn: (client: ImapClient, box: MailboxObject) => Promise<T>,
  createClient: ImapClientFactory,
  live: { client: ImapClient | null },
  signal: AbortSignal,
): Promise<T> {
  const pinned = await resolveEgressAddress(egress, target.host, {
    port: target.port,
    privateAllow: target.privateAllow,
    timeoutMs: IMAP_TIMEOUTS.connectMs,
  });
  // Ended while resolving: no connection is opened (the abort handler closes only a client it can see).
  if (signal.aborted) throw new SessionAborted();
  const client = createClient(
    imapOptionsFor({
      pinned,
      host: target.host,
      port: target.port,
      testHost: pinned.testHost,
      username: target.username,
      password: target.password,
    }),
  );
  live.client = client;
  // ImapFlow also reports socket failures as 'error' events; the awaited call already rejects with them.
  client.on("error", () => {});
  try {
    await client.connect();
    let lock: Awaited<ReturnType<ImapClient["getMailboxLock"]>>;
    try {
      lock = await client.getMailboxLock(target.folder, { readOnly: true });
    } catch (err) {
      const code = mailErrorCode(err);
      // A refused EXAMINE after a good sign-in is the folder's; a dropped connection stays what it is.
      throw code === "unreachable" || code === "certificate" ? err : new FolderError();
    }
    try {
      const box = client.mailbox;
      if (!box) throw new FolderError();
      return await fn(client, box);
    } finally {
      lock.release();
    }
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

// ---------------------------------------------------------------- reading

export interface MailCursor {
  uidValidity: number | null;
  lastUid: number | null;
}

export interface FetchedMail {
  uid: number;
  source: Buffer;
}

export interface ReadResult {
  uidValidity: number;
  /** The cursor after this read. */
  lastUid: number;
  /** True when the cursor was (re)set to the newest message without reading any (first poll, UIDVALIDITY change). */
  baseline: boolean;
  /** True when UIDVALIDITY changed since the last poll. */
  validityChanged: boolean;
  mails: FetchedMail[];
  /** More new mail is waiting beyond this poll's cap. */
  more: boolean;
  /** Messages in the folder. */
  exists: number;
}

/** The newest UID of the open folder (UIDNEXT − 1, or the highest UID when the server does not report UIDNEXT). */
async function newestUid(client: ImapClient, box: MailboxObject): Promise<number> {
  if (typeof box.uidNext === "number" && box.uidNext > 0) return box.uidNext - 1;
  const all = await client.search({ all: true }, { uid: true });
  return Array.isArray(all) && all.length > 0 ? Math.max(...all) : 0;
}

/**
 * New mail of the open folder since `cursor`: UIDs above `lastUid` (an IMAP `n:*` range also returns the newest
 * message when nothing is newer, so the list is filtered), oldest first, at most `max`, each source capped at 256 KiB
 * through BODY.PEEK. A first read or a changed UIDVALIDITY only sets the cursor to the newest message (never reprocess
 * the mailbox).
 */
export async function readNewMail(
  client: ImapClient,
  box: MailboxObject,
  cursor: MailCursor,
  max = MAX_MAILS_PER_POLL,
): Promise<ReadResult> {
  const uidValidity = Number(box.uidValidity);
  const exists = box.exists ?? 0;
  const validityChanged = cursor.uidValidity !== null && cursor.uidValidity !== uidValidity;
  if (cursor.uidValidity === null || cursor.lastUid === null || validityChanged) {
    return {
      uidValidity,
      lastUid: await newestUid(client, box),
      baseline: true,
      validityChanged,
      mails: [],
      more: false,
      exists,
    };
  }
  const last = cursor.lastUid;
  const same = { uidValidity, baseline: false, validityChanged: false, exists };
  if (typeof box.uidNext === "number" && box.uidNext - 1 <= last) {
    return { ...same, lastUid: last, mails: [], more: false };
  }
  const found = await client.search({ uid: `${last + 1}:*` }, { uid: true });
  const fresh = (Array.isArray(found) ? found : []).filter((u) => u > last).sort((a, b) => a - b);
  const take = fresh.slice(0, max);
  if (take.length === 0) return { ...same, lastUid: last, mails: [], more: false };
  const mails: FetchedMail[] = [];
  for await (const msg of client.fetch(
    take.join(","),
    { uid: true, source: { maxLength: AUTOMATION_LIMITS.mailSourceMaxBytes } },
    { uid: true },
  )) {
    if (msg.source && take.includes(msg.uid)) mails.push({ uid: msg.uid, source: msg.source });
  }
  mails.sort((a, b) => a.uid - b.uid);
  return { ...same, lastUid: take[take.length - 1] as number, mails, more: fresh.length > take.length };
}

/** The idempotency key of a mail without a Message-ID: a hash of UIDVALIDITY and UID. */
export const uidKey = (uidValidity: number, uid: number) =>
  `uid:${createHash("sha256").update(`${uidValidity}:${uid}`).digest("hex")}`;

/**
 * `POST /mailboxes/test` (R8): signs in and opens the folder read-only, nothing saved. Answers the message count or a
 * fixed code.
 */
export async function tryMailbox(
  egress: EgressResolver,
  target: MailboxTarget,
  createClient: ImapClientFactory = defaultClient,
  opts: SessionOptions = {},
): Promise<MailboxTestResult> {
  try {
    return await withMailbox(
      egress,
      target,
      async (_c, box) => ({ ok: true, messages: box.exists ?? 0 }),
      createClient,
      opts,
    );
  } catch (err) {
    return { ok: false, code: mailErrorCode(err) };
  }
}
