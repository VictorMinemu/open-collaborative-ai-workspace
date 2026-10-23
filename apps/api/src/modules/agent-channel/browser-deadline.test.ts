import { BROWSER_TIMEOUTS_MS } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import {
  type SandboxdCallOptions,
  type SandboxdClient,
  SandboxdRefusedError,
  SandboxdUnavailableError,
} from "../sandbox";
import { browserCallBudgetMs, underDeadline } from "./browser";

/**
 * CI p64/p66: the cell gave `ocw_browser_open` 20 s while the API kept waiting for a cold browser start (60 s ensure,
 * then the page): the model read "the workspace could not be reached" and the page opened anyway. Every browser call now
 * runs under one deadline below the cell's budget, and a sandboxd call it cuts is the call's `timeout`.
 */

const target = {
  orgId: "0199a6f0-0000-7000-8000-0000000000f1",
  agentId: "0199a6f0-0000-7000-8000-0000000000b1",
};

/** A sandboxd client whose calls answer after `ms` (or never), aborted like the real one by its options' signal. */
function slowClient(ms: number | null, seen: SandboxdCallOptions[] = []): SandboxdClient {
  const wait = (o: SandboxdCallOptions = {}) =>
    new Promise<never>((resolve, reject) => {
      seen.push(o);
      const timer = ms === null ? null : setTimeout(() => resolve({ ok: true } as never), ms);
      o.signal?.addEventListener("abort", () => {
        if (timer) clearTimeout(timer);
        // The real client drops the cause and says only that sandboxd did not answer (client.ts).
        reject(new SandboxdUnavailableError("browserEnsure", null));
      });
    });
  return {
    call: (_op, _input, o) => wait(o),
    stream: (_op, _input, o) => wait(o),
  } as SandboxdClient;
}

describe("a browser call's deadline (contracts BROWSER_TIMEOUTS_MS)", () => {
  it("open gets the cold-start budget, every other browser tool the call budget", () => {
    expect(browserCallBudgetMs("ocw_browser_open")).toBe(BROWSER_TIMEOUTS_MS.apiOpen);
    for (const tool of [
      "ocw_browser_snapshot",
      "ocw_browser_act",
      "ocw_browser_screenshot",
      "ocw_browser_wait",
      "ocw_browser_signin",
      "ocw_browser_close",
    ] as const) {
      expect(browserCallBudgetMs(tool), tool).toBe(BROWSER_TIMEOUTS_MS.apiCall);
    }
  });

  it("a sandboxd call that outlives the deadline is the call's `timeout`, answered at the deadline", async () => {
    const client = underDeadline(slowClient(null), 120) as SandboxdClient;
    const started = Date.now();
    const err = await client
      .call("browserEnsure", { target }, { timeoutMs: 60_000 })
      .catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(err).toMatchObject({ name: "LocalRefusal", code: "timeout" });
  });

  it("within the deadline the answer passes through with the op's own options; the deadline rides on its signal", async () => {
    const seen: SandboxdCallOptions[] = [];
    const client = underDeadline(slowClient(20, seen), 2_000) as SandboxdClient;
    await expect(client.call("contextOpen", { target } as never, { timeoutMs: 55_000 })).resolves.toEqual({
      ok: true,
    });
    expect(seen[0]?.timeoutMs).toBe(55_000);
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.signal?.aborted).toBe(false);
  });

  it("once the deadline passed, a later call is `timeout` at once and never reaches sandboxd", async () => {
    const seen: SandboxdCallOptions[] = [];
    const client = underDeadline(slowClient(null, seen), 50) as SandboxdClient;
    await client.call("browserEnsure", { target }).catch(() => undefined);
    const err = await client.call("contextOpen", { target } as never).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "timeout" });
    expect(seen).toHaveLength(1);
  });

  it("sandboxd's own refusal inside the deadline is kept as it is", async () => {
    const refusing = {
      call: async () => {
        throw new SandboxdRefusedError("contextNavigate", 409, "navigation_refused");
      },
      stream: async () => {
        throw new SandboxdRefusedError("contextSnapshot", 404, "no_context");
      },
    } as unknown as SandboxdClient;
    const client = underDeadline(refusing, 2_000) as SandboxdClient;
    await expect(client.call("contextNavigate", { target } as never)).rejects.toBeInstanceOf(
      SandboxdRefusedError,
    );
    await expect(client.stream("contextSnapshot", { target } as never)).rejects.toMatchObject({
      code: "no_context",
    });
  });

  it("no sandboxd configured stays null (the route answers service_unavailable as before)", () => {
    expect(underDeadline(null, 1_000)).toBeNull();
  });
});
