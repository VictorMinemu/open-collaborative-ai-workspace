import { describe, expect, it } from "vitest";
import { readNewSessionPrefs, saveNewSessionPrefs } from "./new-session-prefs";

/** The repository and agent the New session dialog opens on next time (per viewer, this browser only). */

const REPO = "01a11635-d6e7-7c87-9f17-0000000000b2";

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => {
      m.delete(k);
    },
    setItem: (k, v) => {
      m.set(k, v);
    },
  };
}

const broken = {
  getItem() {
    throw new Error("SecurityError");
  },
  setItem() {
    throw new Error("QuotaExceededError");
  },
} as unknown as Storage;

describe("new session prefs", () => {
  it("round-trips the last repository and agent", () => {
    const s = memory();
    saveNewSessionPrefs({ projectId: REPO, runtime: "codex" }, s);
    expect(readNewSessionPrefs(s)).toEqual({ projectId: REPO, runtime: "codex" });
  });

  it("is empty without storage, with blocked storage or with something it did not write", () => {
    expect(readNewSessionPrefs(null)).toEqual({});
    expect(readNewSessionPrefs(broken)).toEqual({});
    expect(() => saveNewSessionPrefs({ projectId: REPO, runtime: "codex" }, broken)).not.toThrow();
    const s = memory();
    s.setItem("ocw.workZone.newSession", "{not json");
    expect(readNewSessionPrefs(s)).toEqual({});
    s.setItem("ocw.workZone.newSession", JSON.stringify({ projectId: 42, runtime: "opencode" }));
    expect(readNewSessionPrefs(s)).toEqual({});
  });

  it("keeps only the fields it knows", () => {
    const s = memory();
    s.setItem(
      "ocw.workZone.newSession",
      JSON.stringify({ projectId: REPO, runtime: "claude-code", permissionMode: "fullAccess" }),
    );
    expect(readNewSessionPrefs(s)).toEqual({ projectId: REPO, runtime: "claude-code" });
  });
});
