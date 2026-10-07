import { INLINE_IMAGE_TYPES, type ModelControl } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { imageGate } from "./image-gate";

/** 06.1 (D-05, P-06, P-08): the session composer only takes what can go to the session, and says why otherwise. */

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

const png = { contentType: "image/png" };

describe("imageGate", () => {
  it("a model that reports it can't read images refuses them, with its name", () => {
    expect(imageGate({ model: model("GPT-6.1 Text", false), file: png })).toEqual({
      ok: false,
      reason: "GPT-6.1 Text can't read images",
    });
    // Without a file: may this session take images at all (the paperclip).
    expect(imageGate({ model: model("GPT-6.1 Text", false) })).toEqual({
      ok: false,
      reason: "GPT-6.1 Text can't read images",
    });
  });

  it("a model that reads images, or does not say (unknown = allowed), takes them", () => {
    expect(imageGate({ model: model("GPT-6.1 Sol", true), file: png })).toEqual({ ok: true });
    expect(imageGate({ model: model("Claude Opus 5.5"), file: png })).toEqual({ ok: true });
    expect(imageGate({ model: null, file: png })).toEqual({ ok: true });
    expect(imageGate({ model: model("Claude Opus 5.5") })).toEqual({ ok: true });
  });

  it("only the four image types can go to a session", () => {
    for (const contentType of ["application/pdf", "text/plain", "image/svg+xml", "application/zip", ""]) {
      expect(imageGate({ model: model("Claude Opus 5.5"), file: { contentType } })).toEqual({
        ok: false,
        reason: "Only images (PNG, JPEG, GIF, WebP) can be sent to a session",
      });
    }
    for (const contentType of INLINE_IMAGE_TYPES) {
      expect(imageGate({ model: model("Claude Opus 5.5"), file: { contentType } })).toEqual({ ok: true });
    }
    expect(imageGate({ model: null, file: { contentType: "IMAGE/PNG " } })).toEqual({ ok: true });
  });

  it("a non-image is refused for its type even on a text-only model", () => {
    expect(
      imageGate({ model: model("GPT-6.1 Text", false), file: { contentType: "application/pdf" } }),
    ).toEqual({
      ok: false,
      reason: "Only images (PNG, JPEG, GIF, WebP) can be sent to a session",
    });
  });

  it("images never go with a / command", () => {
    expect(imageGate({ model: model("Claude Opus 5.5"), file: png, slashCommand: true })).toEqual({
      ok: false,
      reason: "Images can't be sent with a / command",
    });
    expect(imageGate({ model: model("Claude Opus 5.5"), file: png, slashCommand: false })).toEqual({
      ok: true,
    });
  });
});
