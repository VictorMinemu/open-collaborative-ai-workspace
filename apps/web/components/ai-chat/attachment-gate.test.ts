import { AI_TEXT_INLINE_MAX_BYTES, type AiModelOption } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { attachmentGate, readableSummary } from "./attachment-gate";

/** AICHAT-08 (05-12): the composer only offers what the selected model can read, and says why otherwise. */

const model = (label: string, vision: boolean, pdf: boolean): AiModelOption => ({
  ref: { backend: "org_key", provider: "anthropic", modelId: label.toLowerCase().replaceAll(" ", "-") },
  label,
  providerLabel: "Anthropic",
  group: "organization",
  metered: true,
  caps: { vision, pdf, webSearch: "function" },
  available: true,
  reason: null,
  isDefault: false,
});

const SONNET = model("Claude Sonnet 5.5", true, true);
const ASTRA_NO_PDF = model("GPT-5.6 Luna", true, false);
const LLAMA = model("llama-4-70b", false, false);

const png = { contentType: "image/png", size: 2_000 };
const pdf = { contentType: "application/pdf", size: 40_000 };

describe("attachmentGate", () => {
  it("images need vision", () => {
    expect(attachmentGate(SONNET, png)).toEqual({ ok: true });
    expect(attachmentGate(LLAMA, png)).toEqual({ ok: false, reason: "llama-4-70b can't read images" });
    expect(attachmentGate(LLAMA, { contentType: "image/webp", size: 1 }).ok).toBe(false);
  });

  it("PDFs need pdf", () => {
    expect(attachmentGate(SONNET, pdf)).toEqual({ ok: true });
    expect(attachmentGate(ASTRA_NO_PDF, pdf)).toEqual({ ok: false, reason: "GPT-5.6 Luna can't read PDFs" });
  });

  it("text files pass on any model up to the inline limit", () => {
    for (const contentType of ["text/plain", "text/markdown", "text/csv", "application/json"]) {
      expect(attachmentGate(LLAMA, { contentType, size: AI_TEXT_INLINE_MAX_BYTES })).toEqual({ ok: true });
    }
    expect(attachmentGate(SONNET, { contentType: "text/plain", size: AI_TEXT_INLINE_MAX_BYTES + 1 })).toEqual(
      {
        ok: false,
        reason: "Text files over 100 KB can't be sent",
      },
    );
  });

  it("other types fail on every model", () => {
    for (const contentType of ["application/zip", "application/octet-stream", "image/svg+xml", "video/mp4"]) {
      expect(attachmentGate(SONNET, { contentType, size: 10 })).toEqual({
        ok: false,
        reason: "This file type can't be sent to a model",
      });
    }
  });

  it("without a model only the type is judged (the API checks again on send)", () => {
    expect(attachmentGate(null, pdf)).toEqual({ ok: true });
    expect(attachmentGate(null, { contentType: "application/zip", size: 1 }).ok).toBe(false);
  });
});

describe("readableSummary (the paperclip hint)", () => {
  it("lists what the selected model reads", () => {
    expect(readableSummary(SONNET)).toBe("Claude Sonnet 5.5 reads images, PDFs and text files");
    expect(readableSummary(ASTRA_NO_PDF)).toBe("GPT-5.6 Luna reads images and text files");
    expect(readableSummary(LLAMA)).toBe("llama-4-70b reads text files only");
  });
});
