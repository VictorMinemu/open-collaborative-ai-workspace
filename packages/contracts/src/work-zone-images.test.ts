import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
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
