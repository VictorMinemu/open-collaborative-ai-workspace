import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { Demuxer, demux } from "./docker";
import { OutputTail, tailText } from "./sandboxes";

function frame(stream: 1 | 2, text: string | Buffer): Buffer {
  const payload = typeof text === "string" ? Buffer.from(text, "utf8") : text;
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function collect(frames: { stream: 1 | 2; data: Buffer }[]) {
  const out = { stdout: "", stderr: "" };
  for (const f of frames) out[f.stream === 2 ? "stderr" : "stdout"] += f.data.toString("utf8");
  return out;
}

describe("Demuxer (Docker multiplexed stream, no TTY)", () => {
  const recorded = Buffer.concat([
    frame(1, "hi\n"),
    frame(2, "warn: x\n"),
    frame(1, "10001\n"),
    frame(2, ""),
  ]);

  it("splits a recorded buffer into stdout and stderr", () => {
    expect(collect(new Demuxer().push(recorded))).toEqual({ stdout: "hi\n10001\n", stderr: "warn: x\n" });
  });

  it("handles a frame split across chunks, header and payload alike", () => {
    const d = new Demuxer();
    const frames = [
      ...d.push(recorded.subarray(0, 5)),
      ...d.push(recorded.subarray(5, 13)),
      ...d.push(recorded.subarray(13, 20)),
      ...d.push(recorded.subarray(20)),
    ];
    expect(collect(frames)).toEqual({ stdout: "hi\n10001\n", stderr: "warn: x\n" });
    expect(d.buffered).toBe(0);
  });

  it("survives a byte-by-byte feed and keeps an incomplete frame buffered", () => {
    const d = new Demuxer();
    const frames = [];
    for (let i = 0; i < recorded.length - 1; i++) frames.push(...d.push(recorded.subarray(i, i + 1)));
    // The last frame is an 8-byte empty stderr frame: its final header byte is still missing.
    expect(d.buffered).toBe(7);
    frames.push(...d.push(recorded.subarray(recorded.length - 1)));
    expect(collect(frames)).toEqual({ stdout: "hi\n10001\n", stderr: "warn: x\n" });
  });

  it("demux() feeds a stream until it ends", async () => {
    const s = new PassThrough();
    const got: { stream: 1 | 2; data: Buffer }[] = [];
    const done = demux(s, (f) => got.push(f));
    s.write(recorded.subarray(0, 9));
    s.end(recorded.subarray(9));
    await done;
    expect(collect(got)).toEqual({ stdout: "hi\n10001\n", stderr: "warn: x\n" });
  });
});

describe("output tails (SANDBOX_LIMITS.outputTailBytes)", () => {
  it("keeps the last bytes and says it truncated", () => {
    const t = new OutputTail(16);
    t.push(Buffer.from("0123456789"));
    t.push(Buffer.from("abcdefghij"));
    expect(t.text()).toBe("456789abcdefghij");
    expect(t.truncated).toBe(true);
  });

  it("cuts on a character boundary and never exceeds the byte bound, even for binary output", () => {
    expect(tailText(Buffer.from("aé€😀"), 5)).toBe("😀");
    const binary = Buffer.alloc(64, 0xff);
    const text = tailText(binary, 16);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16);
  });
});
