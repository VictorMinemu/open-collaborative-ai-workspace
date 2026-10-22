import { describe, expect, it } from "vitest";
import { postureRefused } from "./browser";

/** D-14 (07.8-13 owed to 16): the API reads Chromium's sandbox posture from `browserEnsure` and never runs a fallback. */
describe("postureRefused (D-14)", () => {
  it("under gVisor only chromium+gvisor runs; a silent fallback is refused", () => {
    expect(postureRefused({ runtime: "gvisor", browserSandbox: "chromium+gvisor" })).toBe(false);
    expect(postureRefused({ runtime: "gvisor", browserSandbox: "chromium" })).toBe(true);
    expect(postureRefused({ runtime: "gvisor", browserSandbox: "container-only" })).toBe(true);
  });

  it("on hardened runc both honest postures run; a gVisor claim there is refused", () => {
    expect(postureRefused({ runtime: "hardened-runc", browserSandbox: "chromium" })).toBe(false);
    expect(postureRefused({ runtime: "hardened-runc", browserSandbox: "container-only" })).toBe(false);
    expect(postureRefused({ runtime: "hardened-runc", browserSandbox: "chromium+gvisor" })).toBe(true);
  });

  it("a broker that reports no posture is not judged", () => {
    expect(postureRefused({ runtime: "gvisor", browserSandbox: null })).toBe(false);
    expect(postureRefused({ runtime: null, browserSandbox: null })).toBe(false);
  });
});
