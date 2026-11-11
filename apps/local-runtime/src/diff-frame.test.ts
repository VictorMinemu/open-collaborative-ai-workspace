// 07.17.1.1 (D-14, PD-19, E23): a `diff.result` never exceeds the API's inbound frame limit.

import { DEVICE_LINK_MAX_DEVICE_FRAME_BYTES, type DiffFile, DiffResultFrame } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { boundDiffFrame } from "./diff-frame.js";

const BOUND = DEVICE_LINK_MAX_DEVICE_FRAME_BYTES - 4096;

function bytesOf(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v), "utf8");
}

function frame(patch: string, files: DiffFile[], truncated?: boolean): DiffResultFrame {
  return {
    type: "diff.result",
    requestId: "d1",
    files,
    patch,
    ...(truncated !== undefined ? { truncated } : {}),
    branch: "main",
    headSha: "0123456789abcdef0123456789abcdef01234567",
  };
}

/** `n` added lines of `width` characters each (a new file's patch). */
function addedLines(n: number, width: number, ch = "x"): string {
  const lines = ["diff --git a/big.txt b/big.txt", "new file mode 100644", "--- /dev/null", "+++ b/big.txt"];
  for (let i = 0; i < n; i++) lines.push(`+${ch.repeat(width)}`);
  return `${lines.join("\n")}\n`;
}

describe("boundDiffFrame (PD-19)", () => {
  it("a 500 KiB patch is cut at a newline under the bound, truncated: true, a prefix of the original", () => {
    const patch = addedLines(5200, 100);
    expect(Buffer.byteLength(patch)).toBeGreaterThan(500 * 1024);
    const files: DiffFile[] = [{ path: "big.txt", status: "added", additions: 5200, deletions: 0 }];
    const out = boundDiffFrame(frame(patch, files, false), DEVICE_LINK_MAX_DEVICE_FRAME_BYTES);
    expect(bytesOf(out)).toBeLessThanOrEqual(BOUND);
    expect(out.truncated).toBe(true);
    expect(patch.startsWith(out.patch)).toBe(true);
    expect(out.patch.endsWith("\n")).toBe(true);
    expect(out.patch.length).toBeGreaterThan(200 * 1024);
    expect(out.files).toEqual(files);
    expect(DiffResultFrame.parse(out)).toEqual(out);
  });

  it("characters that grow when serialised (quotes, backslashes, controls, non-ASCII) still stay under the bound", () => {
    const patch = [addedLines(3000, 40, '"'), addedLines(3000, 40, "\\"), addedLines(2000, 20, "é")].join("");
    const out = boundDiffFrame(frame(patch, []), DEVICE_LINK_MAX_DEVICE_FRAME_BYTES);
    expect(bytesOf(out)).toBeLessThanOrEqual(BOUND);
    expect(out.truncated).toBe(true);
    expect(patch.startsWith(out.patch)).toBe(true);
  });

  it("5 000 files with 1 000-character paths and an empty patch: the list is cut, the bound holds, the frame parses", () => {
    const files: DiffFile[] = Array.from({ length: 5000 }, (_, i) => ({
      path: `${String(i).padStart(4, "0")}/${"p".repeat(995)}`,
      status: "modified",
      additions: 1,
      deletions: 1,
    }));
    const out = boundDiffFrame(frame("", files), DEVICE_LINK_MAX_DEVICE_FRAME_BYTES);
    expect(bytesOf(out)).toBeLessThanOrEqual(BOUND);
    expect(out.truncated).toBe(true);
    expect(out.files.length).toBeGreaterThan(100);
    expect(out.files.length).toBeLessThan(5000);
    expect(out.files).toEqual(files.slice(0, out.files.length));
    // The longest prefix that fits: one more file would not.
    expect(bytesOf({ ...out, files: files.slice(0, out.files.length + 1) })).toBeGreaterThan(BOUND);
    expect(DiffResultFrame.parse(out)).toEqual(out);
  });

  it("a big patch and a big list: the patch goes first, then the list is cut", () => {
    const files: DiffFile[] = Array.from({ length: 2000 }, (_, i) => ({
      path: `${i}/${"q".repeat(500)}`,
      status: "added",
      additions: 1,
      deletions: 0,
    }));
    const out = boundDiffFrame(frame(addedLines(5000, 100), files), DEVICE_LINK_MAX_DEVICE_FRAME_BYTES);
    expect(bytesOf(out)).toBeLessThanOrEqual(BOUND);
    expect(out.patch).toBe("");
    expect(out.files.length).toBeLessThan(2000);
    expect(out.truncated).toBe(true);
  });

  it("a small frame is returned unchanged, truncated as it was", () => {
    const small = frame("diff --git a/x b/x\n+one\n", [
      { path: "x", status: "modified", additions: 1, deletions: 0 },
    ]);
    expect(boundDiffFrame(small, DEVICE_LINK_MAX_DEVICE_FRAME_BYTES)).toEqual(small);
    expect(boundDiffFrame(small, DEVICE_LINK_MAX_DEVICE_FRAME_BYTES)).not.toHaveProperty("truncated");
    const marked = frame("x\n", [], true);
    expect(boundDiffFrame(marked, DEVICE_LINK_MAX_DEVICE_FRAME_BYTES)).toEqual(marked);
  });
});
