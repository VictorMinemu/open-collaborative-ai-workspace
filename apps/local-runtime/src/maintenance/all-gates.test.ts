import type { RuntimeId } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { allIdle, closeAll, closeAllIfIdle, openAll, runningCount } from "./all-gates.js";
import { RuntimeGate } from "./gate.js";

/** Lets every queued microtask (and the ones they queue) run. */
async function flush(rounds = 10) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Real gates for both runtimes and a fake `activeTurns` the test sets per runtime. */
function setup() {
  const gates = new Map<RuntimeId, RuntimeGate>([
    ["claude-code", new RuntimeGate()],
    ["codex", new RuntimeGate()],
  ]);
  const turns: Partial<Record<RuntimeId, number>> = {};
  const activeTurns = (id: RuntimeId) => turns[id] ?? 0;
  const gate = (id: RuntimeId) => gates.get(id) as RuntimeGate;
  return { gates, turns, activeTurns, gate };
}

describe("all-gates (ADR-0040 § 7, 07.13.1 D-07)", () => {
  it("closeAllIfIdle closes every gate in one call when nothing is admitted and no runtime runs a turn", () => {
    const { gates, activeTurns, gate } = setup();
    expect(allIdle(gates, activeTurns)).toBe(true);
    expect(closeAllIfIdle(gates, activeTurns)).toBe(true);
    expect(gate("claude-code").isOpen).toBe(false);
    expect(gate("codex").isOpen).toBe(false);
  });

  it("a turn in flight on any runtime: closeAllIfIdle returns false and touches no gate", () => {
    const { gates, turns, activeTurns, gate } = setup();
    turns.codex = 1;
    expect(allIdle(gates, activeTurns)).toBe(false);
    expect(closeAllIfIdle(gates, activeTurns)).toBe(false);
    expect(gate("claude-code").isOpen).toBe(true);
    expect(gate("codex").isOpen).toBe(true);
  });

  it("runningCount sums activeTurns and admitted over every runtime", async () => {
    const { gates, turns, activeTurns, gate } = setup();
    expect(runningCount(gates, activeTurns)).toBe(0);
    turns["claude-code"] = 2;
    turns.codex = 1;
    const d = deferred();
    const call = gate("codex").admit(() => d.promise);
    expect(runningCount(gates, activeTurns)).toBe(4);
    d.resolve();
    await call;
    expect(runningCount(gates, activeTurns)).toBe(3);
  });

  it("closeAll closes whatever runs; openAll releases held callers in arrival order", async () => {
    const { gates, turns, gate } = setup();
    turns.codex = 1;
    closeAll(gates);
    expect(gate("claude-code").isOpen).toBe(false);
    expect(gate("codex").isOpen).toBe(false);
    const order: string[] = [];
    const a = gate("claude-code").admit(async () => {
      order.push("a");
    });
    const b = gate("claude-code").admit(async () => {
      order.push("b");
    });
    const c = gate("codex").admit(async () => {
      order.push("c");
    });
    await flush();
    expect(order).toEqual([]);
    openAll(gates);
    await Promise.all([a, b, c]);
    expect(order).toEqual(["a", "b", "c"]);
    expect(gate("claude-code").isOpen).toBe(true);
    expect(gate("codex").isOpen).toBe(true);
  });

  it("openAll leaves a sealed gate closed (07.17.1 WR-01)", async () => {
    const { gates, gate } = setup();
    gate("codex").seal();
    gate("claude-code").close();
    openAll(gates);
    expect(gate("claude-code").isOpen).toBe(true);
    expect(gate("codex").isOpen).toBe(false);
  });

  it("a command inside admit with no turn reported yet: closeAllIfIdle returns false and touches no gate (ADR-0040 § 7)", async () => {
    const { gates, activeTurns, gate } = setup();
    const d = deferred();
    // Admitted, but the adapter has not started the turn: activeTurns is still 0 everywhere.
    const call = gate("claude-code").admit(() => d.promise);
    expect(gate("claude-code").admitted).toBe(1);
    expect(activeTurns("claude-code")).toBe(0);
    expect(allIdle(gates, activeTurns)).toBe(false);
    expect(closeAllIfIdle(gates, activeTurns)).toBe(false);
    expect(gate("claude-code").isOpen).toBe(true);
    expect(gate("codex").isOpen).toBe(true);
    d.resolve();
    await call;
    expect(closeAllIfIdle(gates, activeTurns)).toBe(true);
  });
});
