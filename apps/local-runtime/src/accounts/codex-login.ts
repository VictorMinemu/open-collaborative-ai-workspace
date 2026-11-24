// Codex's own ChatGPT sign-in for one account slot (07.18, D-02, D-10, PD-10, A-08).
//
// Each call spawns one `codex app-server` (the slot arguments, `CODEX_SLOT_APP_SERVER_ARGS`: 07.18-19 R1.7) with the filtered
// child environment (`codexChildEnv`, API keys stripped) plus `CODEX_HOME` = the slot directory, and cwd = the slot. Codex
// itself runs the device-code flow and writes the slot's `auth.json`; this module never reads, copies or logs it.
//
// The device code goes only to `onCode` (the caller sends it to the admin who started the sign-in, or prints it on the
// owner's terminal); it is never logged, and Codex's stderr is drained unread (it may echo the code). The account's
// e-mail from `account/read` is dropped here (P2): callers get the plan type only. The whole login is bounded (15
// minutes, `POOL_LIMITS.signInCodeTtlMs`) and the app-server is always stopped at the end.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { POOL_LIMITS, type PoolSignInErrorCode } from "@ocw/contracts";
import {
  type AppServerProcess,
  CODEX_APP_SERVER_ARGS,
  CODEX_SLOT_APP_SERVER_ARGS,
  codexChildEnv,
  type SpawnAppServer,
} from "../codex/codex-runtime.js";
import type { InitializeParams } from "../codex/generated/InitializeParams.js";
import { JsonRpcError, type JsonRpcNotification, JsonRpcPeer } from "../codex/jsonrpc.js";
import { type Logger, silentLogger } from "../logger.js";
import {
  CODEX_DEVICE_CODE_LOGIN,
  CodexAccountRead,
  CodexDeviceCodeLoginStart,
  type CodexLoginCancelParams,
  CodexLoginCompleted,
  CodexLoginStartAnswer,
} from "./codex-protocol.js";

/** The bound on one sign-in, from the moment the app-server starts (the code's lifetime as the server shows it). */
export const CODEX_LOGIN_TIMEOUT_MS = POOL_LIMITS.signInCodeTtlMs;
const INIT_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const CANCEL_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 3_000;

export const CODEX_UPDATE_MESSAGE = "Update Codex on this device and try again";
export const CODEX_NOT_AVAILABLE_MESSAGE = "Codex is not installed on this device";
export const CODEX_STOPPED_MESSAGE = "Codex stopped before the sign-in finished";
export const CODEX_LOGIN_CANCELLED_MESSAGE = "The sign-in was cancelled";
export const CODEX_LOGIN_EXPIRED_MESSAGE = "The code expired before the sign-in finished. Start again.";
export const CODEX_LOGIN_DENIED_MESSAGE = "The sign-in was declined";

/** A sign-in that did not finish, with the code the server shows (`PoolSignInErrorCode`). */
export class CodexLoginError extends Error {
  constructor(
    readonly code: PoolSignInErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CodexLoginError";
  }
}

export interface DeviceCode {
  verificationUrl: string;
  userCode: string;
  /** ISO time the server shows as the code's end (now + 15 minutes). */
  expiresAt: string;
}

interface AppServerCall {
  spawn: SpawnAppServer;
  /** The slot directory: `CODEX_HOME` and cwd of the app-server. */
  home: string;
  /** The environment the child's is filtered from (default `process.env`). */
  env?: NodeJS.ProcessEnv;
}

export interface CodexDeviceLoginOptions extends AppServerCall {
  /** Called once with the device code, before waiting for the owner to finish in the browser. */
  onCode: (code: DeviceCode) => void;
  signal?: AbortSignal;
  /** Tests only: a shorter bound than `CODEX_LOGIN_TIMEOUT_MS`. */
  timeoutMs?: number;
  now?: () => number;
}

/**
 * The real spawner for account app-servers: `codexPath` (the configured or detected CLI) with the daemon's usual
 * arguments. No CLI → `unsupported`. A spawn that fails later (EACCES) ends the output, so the call fails as `failed`.
 */
export function codexAccountSpawner(codexPath: string | null, log: Logger = silentLogger): SpawnAppServer {
  return ({ cwd, env, args = CODEX_APP_SERVER_ARGS }) => {
    if (!codexPath || !existsSync(codexPath)) {
      throw new CodexLoginError("unsupported", CODEX_NOT_AVAILABLE_MESSAGE);
    }
    const child = spawn(codexPath, [...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    child.on("error", (err) => {
      // The code only: the error text names the binary's absolute path.
      log.warn("codex app-server for an account slot could not be started", {
        code: (err as NodeJS.ErrnoException).code ?? "error",
      });
      child.stdout?.destroy(new Error("codex app-server could not be started"));
    });
    // Drained, never logged: Codex may print the device code there.
    child.stderr?.resume();
    return child as unknown as AppServerProcess;
  };
}

interface Connection {
  peer: JsonRpcPeer;
  /** Notifications seen so far, then every new one through `onNotification`. */
  onNotification(fn: (n: JsonRpcNotification) => void): void;
  /** Resolves when the app-server's output ends. */
  closed: Promise<void>;
}

/** One app-server under the slot for `fn`, always stopped afterwards. */
async function withAppServer<T>(call: AppServerCall, fn: (c: Connection) => Promise<T>): Promise<T> {
  const env = { ...codexChildEnv(call.env ?? process.env, false), CODEX_HOME: call.home };
  let proc: AppServerProcess;
  try {
    proc = call.spawn({ cwd: call.home, env, args: CODEX_SLOT_APP_SERVER_ARGS });
  } catch (err) {
    if (err instanceof CodexLoginError) throw err;
    throw new CodexLoginError("unsupported", CODEX_NOT_AVAILABLE_MESSAGE);
  }
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  const listeners = new Set<(n: JsonRpcNotification) => void>();
  let markClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const peer = new JsonRpcPeer(proc.stdout, proc.stdin, {
    onNotification: (n) => {
      for (const l of listeners) l(n);
    },
    onRequest: () => Promise.reject(new JsonRpcError("not supported by this client", -32601)),
    onClose: () => markClosed(),
  });
  try {
    const init: InitializeParams = {
      clientInfo: { name: "ocw_local_runtime", title: "Open Collaborative AI Workspace", version: "0.0.0" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    };
    try {
      await peer.request("initialize", init, INIT_TIMEOUT_MS);
    } catch {
      throw new CodexLoginError("failed", "Codex could not be started on this device");
    }
    peer.notify("initialized");
    return await fn({ peer, onNotification: (l) => listeners.add(l), closed });
  } finally {
    listeners.clear();
    proc.stdin.end();
    proc.kill("SIGTERM");
    const gone = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), STOP_GRACE_MS).unref()),
    ]);
    if (!gone) proc.kill("SIGKILL");
    peer.close();
  }
}

/** A finished sign-in that did not succeed, from Codex's error text (never shown as is: it may echo the code). */
function classifyCompletion(error: string | null | undefined): CodexLoginError {
  const text = error ?? "";
  if (/denied|declin|reject/i.test(text)) return new CodexLoginError("denied", CODEX_LOGIN_DENIED_MESSAGE);
  if (/expir|timed?[ _-]?out/i.test(text)) return new CodexLoginError("expired", CODEX_LOGIN_EXPIRED_MESSAGE);
  return new CodexLoginError("failed", text ? `The sign-in failed: ${text}` : "The sign-in failed");
}

/** A Codex that does not know the device-code variant answers an invalid-request / params error (A-08). */
function isUnsupported(err: unknown): boolean {
  if (!(err instanceof JsonRpcError)) return false;
  return (
    [-32600, -32601, -32602].includes(err.code) ||
    /unknown variant|chatgptDeviceCode|unsupported/i.test(err.message)
  );
}

/**
 * Codex's device-code sign-in under the slot: `account/login/start` `{ type: "chatgptDeviceCode" }`, the code to
 * `onCode`, then `account/login/completed`; on success the plan from `account/read`. Rejects with a `CodexLoginError`:
 * `denied`, `expired` (also the 15-minute bound), `cancelled` (`signal`), `unsupported` (A-08, or no Codex) or `failed`.
 */
export async function runCodexDeviceLogin(
  opts: CodexDeviceLoginOptions,
): Promise<{ planType: string | null }> {
  const now = opts.now ?? Date.now;
  const bound = opts.timeoutMs ?? CODEX_LOGIN_TIMEOUT_MS;
  const startedAt = now();
  return withAppServer(opts, async ({ peer, onNotification, closed }) => {
    const completions: Array<{ loginId: string | null; success: boolean; error: string | null }> = [];
    let wake: () => void = () => undefined;
    onNotification((n) => {
      if (n.method !== "account/login/completed") return;
      const parsed = CodexLoginCompleted.safeParse(n.params);
      if (!parsed.success) return;
      completions.push({
        loginId: parsed.data.loginId ?? null,
        success: parsed.data.success,
        error: parsed.data.error ?? null,
      });
      wake();
    });

    let answer: unknown;
    try {
      answer = await peer.request("account/login/start", CODEX_DEVICE_CODE_LOGIN, REQUEST_TIMEOUT_MS);
    } catch (err) {
      if (isUnsupported(err)) throw new CodexLoginError("unsupported", CODEX_UPDATE_MESSAGE);
      if (peer.isClosed) throw new CodexLoginError("failed", CODEX_STOPPED_MESSAGE);
      throw new CodexLoginError("failed", "Codex could not start the sign-in");
    }
    const kind = CodexLoginStartAnswer.safeParse(answer);
    if (!kind.success || kind.data.type !== CODEX_DEVICE_CODE_LOGIN.type) {
      throw new CodexLoginError("unsupported", CODEX_UPDATE_MESSAGE);
    }
    const start = CodexDeviceCodeLoginStart.safeParse(answer);
    if (!start.success) throw new CodexLoginError("failed", "Codex answered an unexpected sign-in code");
    const { loginId, verificationUrl, userCode } = start.data;
    const cancelAtCodex = () =>
      peer
        .request("account/login/cancel", { loginId } satisfies CodexLoginCancelParams, CANCEL_TIMEOUT_MS)
        .catch(() => undefined);

    opts.onCode({ verificationUrl, userCode, expiresAt: new Date(startedAt + bound).toISOString() });

    const outcome = await new Promise<
      { kind: "done"; success: boolean; error: string | null } | { kind: "aborted" | "timeout" | "closed" }
    >((resolve) => {
      const finish = (v: Parameters<typeof resolve>[0]) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const check = () => {
        const done = completions.find((c) => c.loginId === null || c.loginId === loginId);
        if (done) finish({ kind: "done", success: done.success, error: done.error });
      };
      const onAbort = () => finish({ kind: "aborted" });
      const timer = setTimeout(() => finish({ kind: "timeout" }), Math.max(0, startedAt + bound - now()));
      timer.unref?.();
      wake = check;
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      void closed.then(() => finish({ kind: "closed" }));
      if (opts.signal?.aborted) onAbort();
      check();
    });

    switch (outcome.kind) {
      case "aborted":
        await cancelAtCodex();
        throw new CodexLoginError("cancelled", CODEX_LOGIN_CANCELLED_MESSAGE);
      case "timeout":
        await cancelAtCodex();
        throw new CodexLoginError("expired", CODEX_LOGIN_EXPIRED_MESSAGE);
      case "closed":
        throw new CodexLoginError("failed", CODEX_STOPPED_MESSAGE);
      case "done":
        if (!outcome.success) throw classifyCompletion(outcome.error);
    }
    // Signed in: the plan only (a failed read leaves it unknown; the sign-in itself succeeded).
    const read = await readAccount(peer).catch(() => null);
    return { planType: read?.planType ?? null };
  });
}

async function readAccount(peer: JsonRpcPeer): Promise<{ signedIn: boolean; planType: string | null }> {
  const parsed = CodexAccountRead.safeParse(await peer.request("account/read", {}, REQUEST_TIMEOUT_MS));
  if (!parsed.success) throw new Error("Codex answered an unexpected account");
  const account = parsed.data.account;
  const signedIn = account?.type === "chatgpt";
  return { signedIn, planType: signedIn ? (account?.planType ?? null) : null };
}

/** Whether the slot has a ChatGPT sign-in, and its plan. The e-mail Codex reports is dropped here (P2). */
export async function readCodexAccount(
  call: AppServerCall,
): Promise<{ signedIn: boolean; planType: string | null }> {
  return withAppServer(call, ({ peer }) => readAccount(peer));
}

/** Signs the slot out in Codex (`account/logout`); the caller removes the slot afterwards. */
export async function logoutCodex(call: AppServerCall): Promise<void> {
  await withAppServer(call, async ({ peer }) => {
    await peer.request("account/logout", undefined, REQUEST_TIMEOUT_MS);
  });
}
