import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Durable cursor: last fully processed `seq` of one cell topic (`cell:<cellId>`).
 *
 * `load()` returns null when nothing was persisted for this topic. The plugin then subscribes from
 * the snapshot's `lastSeq` (live), so a fresh cell never re-answers old mentions.
 *
 * OpenClaw's keyed plugin state store is reserved for bundled/official plugins in 2026.9.7, so the
 * cursor is a small JSON file in the gateway state dir (a named volume in compose).
 */
export type CursorStore = {
  load(topic: string): Promise<number | null>;
  save(topic: string, seq: number): Promise<void>;
};

export function createFileCursorStore(file: string): CursorStore {
  let last = -1;
  let chain: Promise<void> = Promise.resolve();
  return {
    async load(topic) {
      try {
        const parsed = JSON.parse(await readFile(file, "utf8")) as { topic?: unknown; seq?: unknown };
        if (parsed.topic !== topic) return null;
        const seq = parsed.seq;
        if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) return null;
        last = seq;
        return seq;
      } catch {
        return null;
      }
    },
    save(topic, seq) {
      if (seq <= last) return chain;
      last = seq;
      chain = chain.then(async () => {
        await mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify({ topic, seq, savedAt: new Date().toISOString() }), "utf8");
        await rename(tmp, file);
      });
      return chain;
    },
  };
}

export function createMemoryCursorStore(initial: { topic: string; seq: number } | null = null) {
  let state = initial;
  return {
    async load(topic: string) {
      return state && state.topic === topic ? state.seq : null;
    },
    async save(topic: string, seq: number) {
      if (!state || state.topic !== topic || seq > state.seq) state = { topic, seq };
    },
    current: () => state?.seq ?? null,
  } satisfies CursorStore & { current(): number | null };
}
