import { describe, expect, it } from "vitest";
import {
  AgentChannelAttachmentRead,
  AgentChannelAttachmentReadResponse,
  AgentChannelEventTypes,
  AgentMentionEvent,
  AgentWorkSessionEvent,
  ATTACHMENT_READ_LIMITS,
  ATTACHMENT_READ_SENTENCES,
  AttachmentImageType,
  AttachmentReadRefusal,
  SANDBOX_LIMITS,
  WorkSessionTransition,
} from "./index";

const EVENT = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const AGENT = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const FILE = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d";

describe("attachment reads (07.15 D-03, D-04, PD-06; ADR-0015)", () => {
  const request = { eventId: EVENT, agentId: AGENT, attachmentId: FILE };

  it("the request names only the turn's event, the agent and the attachment", () => {
    expect(AgentChannelAttachmentRead.parse(request)).toEqual(request);
    for (const missing of ["eventId", "agentId", "attachmentId"] as const) {
      const { [missing]: _, ...rest } = request;
      expect(AgentChannelAttachmentRead.safeParse(rest).success, missing).toBe(false);
    }
    expect(AgentChannelAttachmentRead.safeParse({ ...request, attachmentId: "photo.png" }).success).toBe(
      false,
    );
    expect(AgentChannelAttachmentRead.safeParse({ ...request, eventId: "evt-1" }).success).toBe(false);
    // Strict: a model-supplied person, URL or path is refused, not ignored (the API binds the asker to the turn).
    for (const extra of [
      { userId: AGENT },
      { url: "https://garage.example/k" },
      { path: "/Users/x/f.csv" },
      { conversationId: EVENT },
    ]) {
      expect(
        AgentChannelAttachmentRead.safeParse({ ...request, ...extra }).success,
        Object.keys(extra)[0],
      ).toBe(false);
    }
  });

  it("the refusal codes are the closed set of twelve, in the hub order, each with one fixed sentence", () => {
    expect(AttachmentReadRefusal.options).toEqual([
      "not_found",
      "policy_changed",
      "model_no_images",
      "unsupported_type",
      "too_large",
      "no_text_layer",
      "encrypted",
      "extraction_failed",
      "timeout",
      "busy",
      "cap_reached",
      "unavailable",
    ]);
    expect(Object.keys(ATTACHMENT_READ_SENTENCES)).toEqual(AttachmentReadRefusal.options);
    for (const [code, sentence] of Object.entries(ATTACHMENT_READ_SENTENCES)) {
      expect(sentence.length, code).toBeGreaterThan(0);
      expect(sentence.length, code).toBeLessThanOrEqual(300);
      expect(sentence, code).not.toMatch(/[{}]|https?|\/[\w.-]+\/|[A-Za-z]:\\/u);
    }
    expect(ATTACHMENT_READ_SENTENCES).toEqual({
      not_found: "This file is not available in this conversation (it may have been deleted).",
      policy_changed: "Reading files is not available on this turn.",
      model_no_images: "This bot's model can't see images, so it can't read this image. Tell the person.",
      unsupported_type:
        "This type of file can't be read as text. If the sandbox is available, copy it with ocw_sandbox_import and use the sandbox tools.",
      too_large: "This file is too large to read.",
      no_text_layer: "This PDF has no text layer (it looks scanned). OCR is not available.",
      encrypted: "This PDF is password-protected, so it can't be read.",
      extraction_failed: "This file couldn't be read (it may be damaged).",
      timeout: "Reading this file took too long and was stopped.",
      busy: "Too many files are being read right now. Try again in a moment.",
      cap_reached:
        "This turn has read as many files (or as much text) as it may. Ask the person to send the question again for more.",
      unavailable: "File storage is not available right now.",
    });
  });

  const text = {
    kind: "text",
    attachmentId: FILE,
    name: "notes.md",
    text: '<untrusted_file name="notes.md">\n# Q4\n</untrusted_file>',
    chars: 5,
    truncated: false,
  };
  const image = {
    kind: "image",
    attachmentId: FILE,
    name: "photo.png",
    mimeType: "image/webp",
    data: "UklGRg==",
    width: null,
    height: null,
  };
  const refused = {
    kind: "refused",
    attachmentId: FILE,
    code: "model_no_images",
    sentence: ATTACHMENT_READ_SENTENCES.model_no_images,
  };
  const imageDataMax = Math.ceil((SANDBOX_LIMITS.previewImageMaxBytes * 4) / 3) + 4;

  it("the answer is text, image or refused, each with its bounds", () => {
    for (const ok of [
      text,
      { ...text, pages: 3, truncated: true, chars: ATTACHMENT_READ_LIMITS.charsPerFile },
      { ...text, text: "x".repeat(ATTACHMENT_READ_LIMITS.charsPerFile + 512), chars: 0 },
      image,
      { ...image, mimeType: "image/jpeg", width: 800, height: 600 },
      { ...image, data: "A".repeat(imageDataMax) },
      refused,
      ...AttachmentReadRefusal.options.map((code) => ({
        ...refused,
        code,
        sentence: ATTACHMENT_READ_SENTENCES[code],
      })),
    ]) {
      expect(AgentChannelAttachmentReadResponse.parse(ok)).toEqual(ok);
    }
    for (const bad of [
      { ...image, mimeType: "image/svg+xml" },
      { ...image, data: "A".repeat(imageDataMax + 1) },
      { ...image, data: "not base64!" },
      { ...image, width: 0 },
      { ...text, kind: "url", url: "https://garage.example/k" },
      { ...text, text: "x".repeat(ATTACHMENT_READ_LIMITS.charsPerFile + 513) },
      { ...text, name: "x".repeat(121) },
      { ...text, chars: -1 },
      { ...text, pages: 0 },
      { ...text, truncated: undefined },
      { ...refused, code: "denied" },
      { ...refused, sentence: "x".repeat(301) },
      { ...refused, attachmentId: "photo.png" },
    ]) {
      expect(
        AgentChannelAttachmentReadResponse.safeParse(bad).success,
        JSON.stringify(bad).slice(0, 100),
      ).toBe(false);
    }
  });

  it("no answer variant has a URL, key or path field: the bytes travel only inside the answer", () => {
    const shapes = AgentChannelAttachmentReadResponse.options.map((o) => Object.keys(o.shape));
    expect(shapes.map((keys) => keys[0])).toEqual(["kind", "kind", "kind"]);
    for (const keys of shapes) {
      for (const key of keys) expect(key).not.toMatch(/url|key|path/i);
    }
    // Unknown keys never survive the parse either.
    const parsed = AgentChannelAttachmentReadResponse.parse({
      ...image,
      url: "https://garage.example/k",
      key: "org/conv/att",
      path: "/tmp/photo.png",
    });
    expect(Object.keys(parsed).sort()).toEqual(
      ["attachmentId", "data", "height", "kind", "mimeType", "name", "width"].sort(),
    );
  });

  it("images are the four inline types the read layer returns, never SVG", () => {
    expect(AttachmentImageType.options).toEqual(["image/webp", "image/png", "image/jpeg", "image/gif"]);
  });
});

describe("Work Zone wake event (07.16 D-09, D-10, PD-16)", () => {
  const SESSION = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60";
  const MSG = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a61";
  const PERSON = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a62";
  const wake = (transition: string, summary = "Work Zone session in billing-api finished turn 2; nothing is queued.") => ({
    eventId: EVENT,
    seq: 7,
    type: "agent.work_session.v1",
    organizationId: FILE,
    cellId: FILE,
    agent: { id: AGENT, handle: "scout", displayName: "Scout" },
    conversation: { id: FILE, kind: "channel", name: "billing" },
    thread: { rootMessageId: MSG },
    message: {
      id: MSG,
      text: "Work Zone session in billing-api finished turn 2; nothing is queued.",
      createdAt: "2026-11-09T10:00:00.000Z",
      author: { kind: "user", id: PERSON, displayName: "Ana" },
      mentions: [],
    },
    threadHistory: [],
    roster: [],
    workSession: {
      workSessionId: SESSION,
      transition,
      status: "idle",
      summary,
      pendingApprovals: 0,
      deciders: [{ id: PERSON, handle: "ana", displayName: "Ana" }],
    },
  });

  it("has its own event type on the cell stream", () => {
    expect(AgentChannelEventTypes.workSession).toBe("agent.work_session.v1");
    expect([...WorkSessionTransition.options]).toEqual(["turn_done", "waiting_approval", "failed", "ended", "offline"]);
  });

  it("a mention-shaped event with workSession parses for each of the five transitions", () => {
    for (const t of WorkSessionTransition.options) {
      const event = wake(t);
      expect(AgentWorkSessionEvent.parse(event)).toEqual(event);
    }
  });

  it("refuses a sixth transition, a 501-character summary, 4 deciders and the mention type", () => {
    expect(AgentWorkSessionEvent.safeParse(wake("started")).success).toBe(false);
    expect(AgentWorkSessionEvent.safeParse(wake("turn_done", "x".repeat(500))).success).toBe(true);
    expect(AgentWorkSessionEvent.safeParse(wake("turn_done", "x".repeat(501))).success).toBe(false);
    const base = wake("waiting_approval");
    const decider = base.workSession.deciders[0];
    expect(
      AgentWorkSessionEvent.safeParse({
        ...base,
        workSession: { ...base.workSession, deciders: [decider, decider, decider, decider] },
      }).success,
    ).toBe(false);
    expect(
      AgentWorkSessionEvent.safeParse({ ...base, workSession: { ...base.workSession, pendingApprovals: -1 } }).success,
    ).toBe(false);
    expect(AgentWorkSessionEvent.safeParse({ ...base, type: "agent.mention.v1" }).success).toBe(false);
    expect(AgentMentionEvent.safeParse(base).success).toBe(false);
  });
});
