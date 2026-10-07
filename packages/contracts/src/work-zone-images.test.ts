import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEVICE_LINK_MAX_COMMAND_FRAME_BYTES,
  PromptPayload,
  stripImageData,
  WORK_PROMPT_IMAGE_MAX_BYTES,
  WORK_PROMPT_MAX_IMAGES,
} from "./device-link";
import { ModelControl, RuntimeModel } from "./session-settings";
import { CreatePromptRequest, WorkPrompt } from "./work-session";

/** Phase 06.1: images on Work Zone prompts (D-02, P-06). */

const ids = (n: number) => Array.from({ length: n }, () => randomUUID());

const PROMPT = {
  id: randomUUID(),
  workSessionId: randomUUID(),
  authorUserId: randomUUID(),
  authorName: "Víctor Ruiz",
  originDeviceId: null,
  body: "what is wrong here?",
  status: "queued",
  position: 1,
  createdAt: "2026-10-07T10:00:00.000Z",
  dispatchedAt: null,
  completedAt: null,
};

describe("CreatePromptRequest.attachmentIds (D-02)", () => {
  it("accepts a body alone and a body with up to 4 attachment ids", () => {
    expect(CreatePromptRequest.parse({ body: "hi" })).toEqual({ body: "hi" });
    const four = ids(4);
    expect(CreatePromptRequest.parse({ body: "hi", attachmentIds: four })).toEqual({
      body: "hi",
      attachmentIds: four,
    });
  });

  it("refuses 5 ids, a non-uuid and an empty body (the body stays required, P-06)", () => {
    expect(CreatePromptRequest.safeParse({ body: "hi", attachmentIds: ids(5) }).success).toBe(false);
    expect(CreatePromptRequest.safeParse({ body: "hi", attachmentIds: ["not-a-uuid"] }).success).toBe(false);
    expect(CreatePromptRequest.safeParse({ body: "", attachmentIds: ids(1) }).success).toBe(false);
    expect(CreatePromptRequest.safeParse({ attachmentIds: ids(1) }).success).toBe(false);
  });
});

describe("WorkPrompt.attachments", () => {
  it("defaults to [] so prompt.updated events persisted before 06.1 still parse", () => {
    expect(WorkPrompt.parse(PROMPT).attachments).toEqual([]);
  });

  it("carries the prompt's attachments", () => {
    const att = {
      id: randomUUID(),
      conversationId: randomUUID(),
      messageId: null,
      filename: "photo.jpg",
      contentType: "image/jpeg",
      size: 1234,
      status: "ready",
      isImage: true,
      width: 960,
      height: 600,
      previewUrl: "/api/v1/attachments/x/preview",
      largeUrl: "/api/v1/attachments/x/large",
      downloadUrl: "/api/v1/attachments/x/download",
      createdAt: "2026-10-07T10:00:00.000Z",
    };
    expect(WorkPrompt.parse({ ...PROMPT, attachments: [att] }).attachments).toEqual([att]);
  });
});

// Long strings are built at runtime, never written as literals.
const b64 = (chars: number) => "QUJD".repeat(Math.ceil(chars / 4)).slice(0, chars);
const image = (mediaType = "image/png", dataBase64 = b64(64)) => ({ mediaType, dataBase64 });

describe("image and frame limits (P-01)", () => {
  it("pins 4 images of at most 2 MiB each and a 32 MiB command frame that fits them with margin", () => {
    expect(WORK_PROMPT_MAX_IMAGES).toBe(4);
    expect(WORK_PROMPT_IMAGE_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(DEVICE_LINK_MAX_COMMAND_FRAME_BYTES).toBe(32 * 1024 * 1024);
    const worstFrame = WORK_PROMPT_MAX_IMAGES * Math.ceil(WORK_PROMPT_IMAGE_MAX_BYTES / 3) * 4 + 6 * 50_000;
    expect(worstFrame * 2).toBeLessThan(DEVICE_LINK_MAX_COMMAND_FRAME_BYTES);
  });
});

describe("PromptPayload is bounded (P-01)", () => {
  const base = { promptId: "p1", text: "look" };

  it("accepts 4 images and refuses 5", () => {
    expect(PromptPayload.safeParse({ ...base, images: [1, 2, 3, 4].map(() => image()) }).success).toBe(true);
    expect(PromptPayload.safeParse({ ...base, images: [1, 2, 3, 4, 5].map(() => image()) }).success).toBe(
      false,
    );
  });

  it("refuses image/svg+xml, an empty dataBase64 and one longer than the base64 of 2 MiB", () => {
    expect(PromptPayload.safeParse({ ...base, images: [image("image/svg+xml")] }).success).toBe(false);
    expect(PromptPayload.safeParse({ ...base, images: [image("image/png", "")] }).success).toBe(false);
    const max = Math.ceil(WORK_PROMPT_IMAGE_MAX_BYTES / 3) * 4;
    expect(PromptPayload.safeParse({ ...base, images: [image("image/webp", b64(max))] }).success).toBe(true);
    expect(PromptPayload.safeParse({ ...base, images: [image("image/webp", b64(max + 4))] }).success).toBe(
      false,
    );
  });
});

describe("RuntimeModel.imageInput / ModelControl.imageInput (P-08)", () => {
  const model = {
    id: "gpt-6.1-sol",
    displayName: "GPT-6.1 Sol",
    description: null,
    legacy: false,
    isDefault: true,
    badge: null,
    efforts: [],
    defaultEffort: null,
    contextWindows: [],
    defaultContextWindow: null,
    fastMode: { supported: false, reason: null },
    supportsAutoMode: false,
  };

  it("parses with and without imageInput (absent = unknown: older daemons, Claude)", () => {
    expect(RuntimeModel.parse(model).imageInput).toBeUndefined();
    expect(RuntimeModel.parse({ ...model, imageInput: false }).imageInput).toBe(false);
    expect(RuntimeModel.parse({ ...model, imageInput: true }).imageInput).toBe(true);
  });

  it("is passed through on ModelControl", () => {
    const control = {
      ...model,
      available: true,
      reason: null,
      detail: null,
      resolvedModel: null,
      fastMode: { available: false, reason: "runtime", detail: null, supported: false },
    };
    expect(ModelControl.parse({ ...control, imageInput: false }).imageInput).toBe(false);
    expect(ModelControl.parse(control).imageInput).toBeUndefined();
  });
});

describe("stripImageData (P-11)", () => {
  it("removes base64 data URLs and keeps the text around them", () => {
    const out = stripImageData(`x data:image/png;base64,${b64(300)} y`);
    expect(out).toBe("x [image data removed] y");
  });

  it("removes a bare base64 run of 250 characters", () => {
    const out = stripImageData(`failed: ${b64(250)} (end)`);
    expect(out).toBe("failed: [image data removed] (end)");
  });

  it("keeps a 64-character hex sha256 and ordinary text", () => {
    const sha = "ab".repeat(32);
    const text = `sha256 ${sha} is fine: data:image/png is a word here`;
    expect(stripImageData(text)).toBe(text);
  });
});
