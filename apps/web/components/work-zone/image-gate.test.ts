import { INLINE_IMAGE_TYPES, type ModelControl } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { attachmentGate } from "./image-gate";

/**
 * 06.1 and ADR-0045: the session composer takes any file. Images the model reads go inline; everything else goes into
 * the working tree, and is refused only for a real limit (the device, the deny list, the size), with the reason.
 */

const model = (displayName: string, imageInput?: boolean): ModelControl => ({
  id: displayName.toLowerCase().replaceAll(" ", "-"),
  displayName,
  description: null,
  resolvedModel: null,
  legacy: false,
  isDefault: true,
  badge: null,
  efforts: [],
  defaultEffort: null,
  contextWindows: [],
  defaultContextWindow: null,
  fastMode: { available: false, reason: "not_in_catalog", detail: null, supported: false },
  supportsAutoMode: false,
  available: true,
  reason: null,
  detail: null,
  ...(imageInput === undefined ? {} : { imageInput }),
});

const MB = 1024 * 1024;
const files = { supported: true, maxBytes: 25 * MB };
const png = { contentType: "image/png", name: "shot.png", size: 2048 };
const pdf = { contentType: "application/pdf", name: "spec.pdf", size: 40_000 };
const claude = model("Claude Opus 5.5");

describe("attachmentGate", () => {
  it("the paperclip is open on every model, even one that can't read images", () => {
    expect(attachmentGate({ model: model("GPT-6.1 Text", false) })).toEqual({ ok: true, route: null });
    expect(attachmentGate({ model: null })).toEqual({ ok: true, route: null });
  });

  it("any file type goes: PDFs, Markdown, Word, archives, unknown types", () => {
    for (const contentType of [
      "application/pdf",
      "text/markdown",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/zip",
      "image/svg+xml",
      "",
    ]) {
      expect(attachmentGate({ model: claude, files, file: { ...pdf, contentType } })).toEqual({
        ok: true,
        route: "file",
      });
    }
  });

  it("images a model reads (or does not say) go inline, the first four of them", () => {
    for (const contentType of INLINE_IMAGE_TYPES) {
      expect(attachmentGate({ model: claude, files, file: { ...png, contentType } })).toEqual({
        ok: true,
        route: "inline",
      });
    }
    expect(attachmentGate({ model: null, file: { ...png, contentType: "IMAGE/PNG " } })).toEqual({
      ok: true,
      route: "inline",
    });
    expect(attachmentGate({ model: claude, files, file: png, inlineBefore: 3 })).toEqual({
      ok: true,
      route: "inline",
    });
    expect(attachmentGate({ model: claude, files, file: png, inlineBefore: 4 })).toEqual({
      ok: true,
      route: "file",
    });
  });

  it("an image on a model that can't read images goes into the working tree instead of being refused", () => {
    expect(attachmentGate({ model: model("GPT-6.1 Text", false), files, file: png })).toEqual({
      ok: true,
      route: "file",
    });
  });

  it("a device too old for files says to update it; inline images still go", () => {
    const old = { supported: false, maxBytes: 25 * MB };
    expect(attachmentGate({ model: claude, files: old, file: pdf })).toEqual({
      ok: false,
      reason: "Update this device to attach files",
    });
    expect(attachmentGate({ model: claude, files: old, file: png })).toEqual({ ok: true, route: "inline" });
  });

  it("over the per-file limit: Over the N MB limit", () => {
    expect(
      attachmentGate({
        model: claude,
        files: { supported: true, maxBytes: 10 * MB },
        file: { ...pdf, size: 11 * MB },
      }),
    ).toEqual({ ok: false, reason: "Over the 10 MB limit" });
  });

  it("keys and credential files are refused by the shared deny list", () => {
    expect(attachmentGate({ model: claude, files, file: { ...pdf, name: "server.key" } })).toEqual({
      ok: false,
      reason: "Keys and credential files can't be attached; keep them in the secret store",
    });
  });

  it("while the device's answer is unknown the API decides alone", () => {
    expect(attachmentGate({ model: claude, file: { ...pdf, size: 900 * MB } })).toEqual({
      ok: true,
      route: "file",
    });
  });

  it("nothing goes with a / command", () => {
    expect(attachmentGate({ model: claude, file: pdf, slashCommand: true })).toEqual({
      ok: false,
      reason: "Files can't be sent with a / command",
    });
    expect(attachmentGate({ model: claude, file: png, slashCommand: false })).toEqual({
      ok: true,
      route: "inline",
    });
  });
});
