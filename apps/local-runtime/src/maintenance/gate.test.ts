import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeGate } from "./gate.js";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every queued microtask (and the ones they queue) run. */
async function flush(rounds = 10) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RuntimeGate (07.11 PD-07)", () => {
  it("open: admit runs fn at once and counts it while it is pending", async () => {
    const gate = new RuntimeGate();
    expect(gate.isOpen).toBe(true);
    const d = deferred<string>();
    const fn = vi.fn(() => d.promise);
    const result = gate.admit(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(gate.admitted).toBe(1);
    d.resolve("ok");
    await expect(result).resolves.toBe("ok");
    expect(gate.admitted).toBe(0);
  });

  it("a throwing fn is uncounted and its error propagates", async () => {
    const gate = new RuntimeGate();
    await expect(gate.admit(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(gate.admitted).toBe(0);
    await expect(
      gate.admit(() => {
        throw new Error("sync boom");
      }),
    ).rejects.toThrow("sync boom");
    expect(gate.admitted).toBe(0);
  });

  it("closeIfIdle closes only when the adapter reports no turn and nothing is admitted", async () => {
    const gate = new RuntimeGate();
    expect(gate.closeIfIdle(() => 1)).toBe(false);
    expect(gate.isOpen).toBe(true);

    const d = deferred();
    const running = gate.admit(() => d.promise);
    expect(gate.closeIfIdle(() => 0)).toBe(false);
    expect(gate.isOpen).toBe(true);
    d.resolve();
    await running;

    expect(gate.closeIfIdle(() => 0)).toBe(true);
    expect(gate.isOpen).toBe(false);
  });

  it("closed: a caller is held (told once), never run, counted, and released when the gate opens", async () => {
    const gate = new RuntimeGate();
    gate.close();
    const fn = vi.fn(async () => "ran");
    const onHeld = vi.fn();
    const result = gate.admit(fn, onHeld);
    await flush();
    expect(onHeld).toHaveBeenCalledTimes(1);
    expect(fn).not.toHaveBeenCalled();
    expect(gate.heldCount).toBe(1);
    expect(gate.admitted).toBe(0);
    gate.open();
    await expect(result).resolves.toBe("ran");
    expect(onHeld).toHaveBeenCalledTimes(1);
    expect(gate.heldCount).toBe(0);
  });

  it("held callers run in arrival order after open()", async () => {
    const gate = new RuntimeGate();
    gate.close();
    const order: string[] = [];
    const calls = ["a", "b", "c"].map((name) =>
      gate.admit(async () => {
        order.push(name);
      }),
    );
    await flush();
    expect(gate.heldCount).toBe(3);
    gate.open();
    await Promise.all(calls);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("close() drains: it closes regardless of activity and admitted calls finish", async () => {
    const gate = new RuntimeGate();
    const d = deferred();
    const running = gate.admit(() => d.promise);
    gate.close();
    expect(gate.isOpen).toBe(false);
    expect(gate.admitted).toBe(1);
    const held = vi.fn(async () => undefined);
    const later = gate.admit(held);
    d.resolve();
    await running;
    expect(gate.admitted).toBe(0);
    await flush();
    expect(held).not.toHaveBeenCalled();
    gate.open();
    await later;
    expect(held).toHaveBeenCalledTimes(1);
  });

  describe("no window between the idle check and the update (D-03, T-07.11-05-02)", () => {
    it("closeIfIdle in the same tick as open(): the gate closes first and the released caller waits again", async () => {
      const gate = new RuntimeGate();
      gate.close();
      const fn = vi.fn(async () => undefined);
      const onHeld = vi.fn();
      const call = gate.admit(fn, onHeld);
      await flush();
      gate.open();
      // Synchronously, before the released caller's continuation runs.
      expect(gate.closeIfIdle(() => 0)).toBe(true);
      await flush();
      expect(fn).not.toHaveBeenCalled();
      expect(gate.isOpen).toBe(false);
      expect(gate.admitted).toBe(0);
      expect(gate.heldCount).toBe(1);
      expect(onHeld).toHaveBeenCalledTimes(1); // told once, not again on the second wait
      gate.open();
      await call;
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("a caller admitted before closeIfIdle makes it return false and the gate stays open", async () => {
      const gate = new RuntimeGate();
      gate.close();
      const d = deferred();
      const fn = vi.fn(() => d.promise);
      const call = gate.admit(fn);
      await flush();
      gate.open();
      await flush();
      expect(fn).toHaveBeenCalledTimes(1);
      expect(gate.closeIfIdle(() => 0)).toBe(false);
      expect(gate.isOpen).toBe(true);
      d.resolve();
      await call;
    });

    it("whatever the microtask order, a caller is never admitted while the gate is closed", async () => {
      for (const delay of [0, 1, 2, 3, 4, 5]) {
        const gate = new RuntimeGate();
        gate.close();
        const d = deferred();
        let admittedWhileClosed = false;
        const fn = vi.fn(() => {
          if (!gate.isOpen) admittedWhileClosed = true;
          return d.promise;
        });
        const call = gate.admit(fn);
        await flush();
        gate.open();
        let closed: boolean | null = null;
        void (async () => {
          for (let i = 0; i < delay; i++) await Promise.resolve();
          closed = gate.closeIfIdle(() => 0);
        })();
        await flush(20);
        expect(admittedWhileClosed).toBe(false);
        // Exactly one of the two won.
        if (closed) {
          expect(fn).not.toHaveBeenCalled();
          expect(gate.heldCount).toBe(1);
          gate.open();
          await flush();
          expect(fn).toHaveBeenCalledTimes(1);
        } else {
          expect(fn).toHaveBeenCalledTimes(1);
          expect(gate.isOpen).toBe(true);
        }
        d.resolve();
        await call;
      }
    });
  });

  it("waitIdle resolves only when the adapter reports no turn and nothing is admitted", async () => {
    vi.useFakeTimers();
    const gate = new RuntimeGate();
    let turns = 1;
    const d = deferred();
    const running = gate.admit(() => d.promise);
    gate.close();
    let idle = false;
    const waiting = gate
      .waitIdle(() => turns, 1000)
      .then(() => {
        idle = true;
      });
    await vi.advanceTimersByTimeAsync(5000);
    expect(idle).toBe(false);
    turns = 0;
    await vi.advanceTimersByTimeAsync(5000);
    expect(idle).toBe(false); // still one admitted call
    d.resolve();
    await running;
    await vi.advanceTimersByTimeAsync(1000);
    await waiting;
    expect(idle).toBe(true);
  });

  it("waitIdle resolves at once when already idle", async () => {
    const gate = new RuntimeGate();
    await expect(gate.waitIdle(() => 0)).resolves.toBeUndefined();
  });
});

describe("RuntimeGate.seal (07.17.1 review WR-01)", () => {
  it("a sealed gate holds what waits and what arrives, and open() no longer releases anything", async () => {
    const gate = new RuntimeGate();
    gate.close();
    const held = vi.fn(async () => "held");
    void gate.admit(held);
    await flush();
    gate.seal();
    expect(gate.isOpen).toBe(false);
    gate.open();
    const late = vi.fn(async () => "late");
    void gate.admit(late);
    await flush();
    expect(gate.isOpen).toBe(false);
    expect(held).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
    expect(gate.heldCount).toBe(2);
  });

  it("sealing an open gate closes it", async () => {
    const gate = new RuntimeGate();
    gate.seal();
    const fn = vi.fn(async () => undefined);
    void gate.admit(fn);
    await flush();
    expect(fn).not.toHaveBeenCalled();
  });
});
