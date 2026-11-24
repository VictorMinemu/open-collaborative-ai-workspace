// 07.18-19 R1.7: one holder at a time per key (an account slot's `CODEX_HOME`), in this process.
//
// Codex 0.172 serialises a token refresh only inside one process (`AuthManager.refresh_lock`, a semaphore) and holds
// the cross-process `auth.json.lock` only for the commit ("network requests never hold it",
// codex-rs/login/src/auth/storage_commit.rs at rust-v0.172.0). Before refreshing it reloads `auth.json` and skips the
// refresh when another process already rotated the tokens, so processes that refresh one after the other cooperate.
// What it does not cover is two processes exchanging the same single-use refresh token at the same moment, which is
// what app-servers of one slot starting together do when the token is about to expire. The daemon spawns every slot
// app-server, so this lock makes them start one at a time: each holds the slot until its first authenticated read
// has settled, and the next one finds the rotated tokens on disk.

/** A per-key FIFO lock; `acquire` resolves with a release function (idempotent). */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let open: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => {
      open = resolve;
    });
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      open();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }

  /** Whether someone holds or waits for `key` (tests). */
  busy(key: string): boolean {
    return this.tails.has(key);
  }
}
