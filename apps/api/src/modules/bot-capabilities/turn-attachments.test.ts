import { ATTACHMENT_READ_LIMITS, TURN_ATTACHMENT_NOTES } from "@ocw/contracts";
import { describe, expect, it, vi } from "vitest";
import { type AttachmentRow, EXTRACT_LIMITS } from "../artifact";
import { buildTurnAttachments } from "./turn-attachments";

/**
 * 07.15-07 (D-04, D-09, D-13, PD-04): how each listed file can be read by THIS bot on THIS turn, and the fixed note
 * that says why not. Pure: rows built from the `AttachmentRow` type, the cover decision a counted fake.
 */

const MESSAGE = "00000000-0000-7000-8000-00000000000d";
let n = 0;
function row(over: Partial<AttachmentRow> = {}): AttachmentRow {
  n++;
  return {
    id: `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    organizationId: "00000000-0000-7000-8000-00000000000a",
    conversationId: "00000000-0000-7000-8000-00000000000b",
    messageId: MESSAGE,
    workPromptId: null,
    workPromptPosition: null,
    uploaderId: "00000000-0000-7000-8000-00000000000c",
    filename: "file.bin",
    declaredType: "application/octet-stream",
    contentType: "application/octet-stream",
    sizeBytes: 10,
    sha256: null,
    status: "ready",
    scanStatus: "not_scanned",
    hasRenditions: false,
    largeBytes: null,
    width: null,
    height: null,
    eventId: null,
    createdAt: "2026-11-07T12:00:00.000Z",
    completedAt: "2026-11-07T12:00:01.000Z",
    deletedAt: null,
    purgedAt: null,
    ...over,
  } as AttachmentRow;
}

const image = (over: Partial<AttachmentRow> = {}) =>
  row({
    filename: "photo.png",
    declaredType: "image/png",
    contentType: "image/png",
    hasRenditions: true,
    ...over,
  });
const text = () => row({ filename: "notes.md", declaredType: "text/markdown" });
const pdf = () =>
  row({ filename: "report.pdf", declaredType: "application/pdf", contentType: "application/pdf" });
const zip = () =>
  row({ filename: "bundle.zip", declaredType: "application/zip", contentType: "application/zip" });
const bigImage = () => image({ hasRenditions: false, sizeBytes: EXTRACT_LIMITS.imageOriginalMaxBytes + 1 });

const ctx = (imageModel: boolean, importOffered: boolean, covered: boolean) => {
  const importCovered = vi.fn(async () => covered);
  return { imageModel, importOffered, importCovered };
};

const N = TURN_ATTACHMENT_NOTES;

describe("buildTurnAttachments: the access and note per kind, model and sandbox", () => {
  it.each([
    // [label, file, imageModel, importOffered, importCovered, access, note]
    ["image, vision model", image, true, false, false, "read", undefined],
    ["image, vision model, import offered", image, true, true, true, "read", undefined],
    ["image, no vision, import offered and covered", image, false, true, true, "import", N.modelNoImages],
    ["image, no vision, import offered, not covered", image, false, true, false, "none", N.modelNoImages],
    ["image, no vision, no import", image, false, false, false, "none", N.modelNoImages],
    ["text, any bot", text, false, false, false, "read", undefined],
    ["text, sandbox bot", text, true, true, true, "read", undefined],
    ["pdf, any bot", pdf, false, false, false, "read", undefined],
    ["other, import offered and covered", zip, true, true, true, "import", N.cannotReadImport],
    ["other, import offered, not covered", zip, true, true, false, "none", N.cannotReadNarrower],
    ["other, no import", zip, true, false, false, "none", N.cannotReadNoSandbox],
    [
      "image over the original cap without renditions, import covered",
      bigImage,
      true,
      true,
      true,
      "import",
      N.tooLarge,
    ],
    [
      "image over the original cap without renditions, no import",
      bigImage,
      true,
      false,
      false,
      "none",
      N.tooLarge,
    ],
  ] as const)("%s", async (_label, make, imageModel, importOffered, covered, access, note) => {
    const { attachments } = await buildTurnAttachments([make()], ctx(imageModel, importOffered, covered));
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.access).toBe(access);
    if (note === undefined) expect(attachments[0]).not.toHaveProperty("note");
    else expect(attachments[0]?.note).toBe(note);
  });

  it.each([
    ["import covered", true, true, "import"],
    ["no import", false, false, "none"],
  ] as const)(
    "IN-02: a PDF over the 25 MiB read bound is listed tooLarge, never read (%s)",
    async (_l, offered, covered, access) => {
      const big = row({
        filename: "scan.pdf",
        declaredType: "application/pdf",
        contentType: "application/pdf",
        sizeBytes: EXTRACT_LIMITS.pdfMaxBytes + 1,
      });
      const { attachments } = await buildTurnAttachments([big], ctx(true, offered, covered));
      expect(attachments[0]).toMatchObject({ kind: "pdf", access, note: N.tooLarge });
      const exact = { ...big, sizeBytes: EXTRACT_LIMITS.pdfMaxBytes };
      expect((await buildTurnAttachments([exact], ctx(true, offered, covered))).attachments[0]?.access).toBe(
        "read",
      );
    },
  );

  it("an image over the original cap WITH renditions reads (the large.webp rendition)", async () => {
    const big = image({ hasRenditions: true, sizeBytes: EXTRACT_LIMITS.imageOriginalMaxBytes + 1 });
    const { attachments } = await buildTurnAttachments([big], ctx(true, false, false));
    expect(attachments[0]).toMatchObject({ kind: "image", access: "read" });
    expect(attachments[0]).not.toHaveProperty("note");
  });

  it("asks the cover decision at most once per build, and never when every file reads", async () => {
    const all = ctx(true, true, true);
    await buildTurnAttachments([text(), pdf(), image()], all);
    expect(all.importCovered).not.toHaveBeenCalled();
    const mixed = ctx(false, true, false);
    await buildTurnAttachments([zip(), image(), zip(), text()], mixed);
    expect(mixed.importCovered).toHaveBeenCalledTimes(1);
    const noImport = ctx(false, false, true);
    await buildTurnAttachments([zip(), image()], noImport);
    expect(noImport.importCovered).not.toHaveBeenCalled();
  });
});

describe("buildTurnAttachments: the cap, the order and the metadata", () => {
  it("21 rows → 20 listed and more 1; 20 rows → more 0; the input order is kept", async () => {
    const rows = Array.from({ length: 21 }, () => text());
    const over = await buildTurnAttachments(rows, ctx(true, false, false));
    expect(over.attachments.map((a) => a.id)).toEqual(rows.slice(0, 20).map((r) => r.id));
    expect(over.more).toBe(1);
    const exact = await buildTurnAttachments(
      rows.slice(0, ATTACHMENT_READ_LIMITS.listPerTurn),
      ctx(true, false, false),
    );
    expect(exact.attachments).toHaveLength(20);
    expect(exact.more).toBe(0);
  });

  it("two files named a.csv are two entries", async () => {
    const a = row({ filename: "a.csv", declaredType: "text/csv" });
    const b = row({ filename: "a.csv", declaredType: "text/csv" });
    const { attachments } = await buildTurnAttachments([a, b], ctx(true, false, false));
    expect(attachments.map((x) => [x.id, x.name])).toEqual([
      [a.id, "a.csv"],
      [b.id, "a.csv"],
    ]);
  });

  it("metadata only: id, message, bounded name, contentType ?? declaredType, size, kind", async () => {
    const long = `${"x".repeat(300)}.txt`;
    const sniffed = row({
      filename: long,
      declaredType: "text/plain",
      contentType: "text/plain",
      sizeBytes: 42,
    });
    const unsniffed = row({ filename: "x.csv", declaredType: "text/csv", contentType: null });
    const { attachments } = await buildTurnAttachments([sniffed, unsniffed], ctx(true, false, false));
    expect(attachments[0]).toEqual({
      id: sniffed.id,
      messageId: MESSAGE,
      name: long.slice(0, 255),
      mediaType: "text/plain",
      size: 42,
      kind: "text",
      access: "read",
    });
    expect(attachments[1]?.mediaType).toBe("text/csv");
    // A name cut inside a surrogate pair never leaves half of it.
    const emoji = row({ filename: `${"y".repeat(254)}😀.txt`, declaredType: "text/plain" });
    const [cut] = (await buildTurnAttachments([emoji], ctx(true, false, false))).attachments;
    expect(cut?.name).toBe("y".repeat(254));
  });
});
