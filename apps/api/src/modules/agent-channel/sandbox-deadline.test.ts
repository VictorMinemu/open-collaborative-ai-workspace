import { SANDBOX_LIMITS, SANDBOX_TIMEOUTS_MS } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import {
  type SandboxdCallOptions,
  type SandboxdClient,
  SandboxdRefusedError,
  SandboxdUnavailableError,
} from "../sandbox";
import {
  containerStateAfter,
  execYieldMs,
  sandboxCallBudgets,
  sandboxUnderDeadline,
  startWithin,
} from "./sandbox";

/**
 * Sandbox-proof CI p142/p164/p178: a bot's first `ocw_sandbox_exec` met a cold start of its shell that a contended
 * Docker daemon held for 15-42 s. The API waited (60 s for the start, then 40 s for the command) while the cell gave the
 * call 35 s, so the model read "the workspace could not be reached" and the command ran anyway. Every sandbox call now
 * runs under one deadline below the cell's budget: the start has its own share (past it: `starting`, and sandboxd
 * finishes the start for the next call), and the command's yield is what the deadline leaves.
 */

const target = {
  orgId: "0199a6f0-0000-7000-8000-0000000000f1",
  agentId: "0199a6f0-0000-7000-8000-0000000000b1",
};

/** A sandboxd call that answers after `ms` (or never), aborted like the real client by its options' signal. */
function slowCall(ms: number | null, seen: SandboxdCallOptions[] = []) {
  return (o: SandboxdCallOptions = {}) =>
    new Promise<{ ok: true }>((resolve, reject) => {
      seen.push(o);
      const timer = ms === null ? null : setTimeout(() => resolve({ ok: true }), ms);
      const abort = () => {
        if (timer) clearTimeout(timer);
        // The real client drops the cause and says only that sandboxd did not answer (client.ts).
        reject(new SandboxdUnavailableError("ensure", null));
      };
      if (o.signal?.aborted) abort();
      o.signal?.addEventListener("abort", abort);
    });
}

function slowClient(ms: number | null, seen: SandboxdCallOptions[] = []): SandboxdClient {
  const wait = slowCall(ms, seen);
  return {
    call: (_op: unknown, _input: unknown, o?: SandboxdCallOptions) => wait(o),
    stream: (_op: unknown, _input: unknown, o?: SandboxdCallOptions) => wait(o),
  } as unknown as SandboxdClient;
}

describe("a sandbox call's budgets (contracts SANDBOX_TIMEOUTS_MS)", () => {
  it("default to the contract's, a test hook overrides each", () => {
    expect(sandboxCallBudgets()).toEqual({
      apiCall: SANDBOX_TIMEOUTS_MS.apiCall,
      ensure: SANDBOX_TIMEOUTS_MS.ensure,
    });
    expect(sandboxCallBudgets({ ensure: 100 })).toEqual({
      apiCall: SANDBOX_TIMEOUTS_MS.apiCall,
      ensure: 100,
    });
  });
});

describe("the start's share of the call (`startWithin`)", () => {
  it("a start within its share answers the status", async () => {
    await expect(startWithin(500, (signal) => slowCall(20)({ signal }))).resolves.toEqual({ ok: true });
  });

  it("a start longer than its share is `starting`, answered at the share (never later)", async () => {
    const started = Date.now();
    const err = await startWithin(120, (signal) => slowCall(null)({ signal })).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(err).toMatchObject({ name: "LocalRefusal", code: "starting" });
  });

  it("the transport's own deadline is set past the share, so the share always decides first", async () => {
    let backstop = 0;
    await startWithin(200, (signal, backstopMs) => {
      backstop = backstopMs;
      return slowCall(1)({ signal });
    });
    expect(backstop).toBeGreaterThan(200);
  });

  it("sandboxd's own refusal or failure inside the share is kept as it is (a killed organization refuses at once)", async () => {
    const killed = new SandboxdRefusedError("ensure", 409, "killed");
    await expect(
      startWithin(2_000, async () => {
        throw killed;
      }),
    ).rejects.toBe(killed);
    await expect(
      startWithin(2_000, async () => {
        throw new SandboxdUnavailableError("ensure", 503);
      }),
    ).rejects.toBeInstanceOf(SandboxdUnavailableError);
  });
});

describe("the call's deadline (`sandboxUnderDeadline`)", () => {
  it("a sandboxd call that outlives the deadline is the call's `timeout`, answered at the deadline", async () => {
    const client = sandboxUnderDeadline(slowClient(null), Date.now() + 120);
    const started = Date.now();
    const err = await client
      .call("exec", { target } as never, { timeoutMs: 40_000 })
      .catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(err).toMatchObject({ name: "LocalRefusal", code: "timeout" });
  });

  it("within the deadline the answer passes through with the op's own options", async () => {
    const seen: SandboxdCallOptions[] = [];
    const client = sandboxUnderDeadline(slowClient(10, seen), Date.now() + 2_000);
    await expect(client.call("filesList", { target } as never, { timeoutMs: 30_000 })).resolves.toEqual({
      ok: true,
    });
    expect(seen[0]?.timeoutMs).toBe(30_000);
    expect(seen[0]?.signal?.aborted).toBe(false);
  });

  it("past the deadline a call is `timeout` at once and never reaches sandboxd", async () => {
    const seen: SandboxdCallOptions[] = [];
    const client = sandboxUnderDeadline(slowClient(null, seen), Date.now() - 1);
    expect(await client.call("exec", { target } as never).catch((e: unknown) => e)).toMatchObject({
      code: "timeout",
    });
    expect(seen).toHaveLength(0);
  });

  it("sandboxd's own refusal inside the deadline is kept as it is", async () => {
    const refusing = {
      call: async () => {
        throw new SandboxdRefusedError("exec", 404, "not_found");
      },
    } as unknown as SandboxdClient;
    await expect(
      sandboxUnderDeadline(refusing, Date.now() + 2_000).call("exec", { target } as never),
    ).rejects.toBeInstanceOf(SandboxdRefusedError);
  });
});

describe("a command's yield after the start (`execYieldMs`)", () => {
  const margin = SANDBOX_TIMEOUTS_MS.execAnswerMargin;

  it("a warm call keeps the whole yield", () => {
    expect(execYieldMs(false, SANDBOX_TIMEOUTS_MS.apiCall)).toBe(SANDBOX_LIMITS.execYieldMs);
  });

  it("after the slowest start the call allows, the command still yields for what the deadline leaves", () => {
    const left = SANDBOX_TIMEOUTS_MS.apiCall - SANDBOX_TIMEOUTS_MS.ensure;
    expect(execYieldMs(false, left)).toBe(left - margin);
    expect(execYieldMs(false, left)).toBeGreaterThanOrEqual(10_000);
  });

  it("a background command never waits, and the yield is never negative", () => {
    expect(execYieldMs(true, SANDBOX_TIMEOUTS_MS.apiCall)).toBe(0);
    expect(execYieldMs(false, margin - 1)).toBe(0);
    expect(execYieldMs(false, -5)).toBe(0);
  });
});

describe("the container's recorded state after a call (`containerStateAfter`)", () => {
  it("a start the share cut leaves the reservation `starting` (sandboxd finishes it; its state event or the next call settles it)", () => {
    expect(containerStateAfter({ reserved: true, ensured: false, failure: "starting" })).toBeNull();
  });

  it("a kill that won the race is recorded as the kill, not as the service failing", () => {
    expect(containerStateAfter({ reserved: true, ensured: false, failure: "killed" })).toEqual({
      state: "killed",
      stopReason: "kill_switch",
    });
  });

  it("the rest is unchanged: a failed start releases the slot, a start marks it running", () => {
    expect(containerStateAfter({ reserved: true, ensured: false, failure: "service_unavailable" })).toEqual({
      state: "unavailable",
      stopReason: "service_down",
    });
    expect(containerStateAfter({ reserved: true, ensured: false, failure: "timeout" })).toEqual({
      state: "unavailable",
      stopReason: "service_down",
    });
    expect(containerStateAfter({ reserved: true, ensured: true, failure: null })).toEqual({
      state: "running",
      stopReason: null,
    });
    expect(containerStateAfter({ reserved: false, ensured: false, failure: null })).toBeNull();
  });
});
