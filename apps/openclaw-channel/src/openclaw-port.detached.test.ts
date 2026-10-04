import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { runDetached } from "./openclaw-port.js";

const KEY = Symbol.for("openclaw.detachedAsyncContext");
const registry = globalThis as Record<symbol, unknown>;

describe("runDetached", () => {
  afterEach(() => {
    delete registry[KEY];
  });

  it("runs the turn outside the caller's (possibly closed) async scope via OpenClaw's detached root", () => {
    const scope = new AsyncLocalStorage<string>();
    registry[KEY] = new AsyncResource("openclaw.detached-async-context"); // created outside any scope
    const seen = scope.run("closed-scope", () => runDetached(() => scope.getStore()));
    expect(seen).toBeUndefined();
  });

  it("falls back to a direct call when the host does not expose the detached context", () => {
    const scope = new AsyncLocalStorage<string>();
    expect(scope.run("caller", () => runDetached(() => scope.getStore()))).toBe("caller");
  });
});
