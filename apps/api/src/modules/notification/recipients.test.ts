import { describe, expect, it } from "vitest";
import { computeRecipients, type RecipientsInput } from "./recipients";

const ADA = "00000000-0000-4000-8000-00000000000a";
const SAM = "00000000-0000-4000-8000-00000000000b";
const ALEX = "00000000-0000-4000-8000-00000000000c";
const BOB = "00000000-0000-4000-8000-00000000000d";

const base: RecipientsInput = {
  authorUserId: ADA,
  convKind: "channel",
  humanMemberIds: [ADA, SAM, ALEX],
  mentionedUserIds: [],
  mentionAll: null,
  onlineUserIds: new Set(),
  threadParticipantIds: [],
  isThreadReply: false,
};

const asObject = (m: Map<string, string>) =>
  Object.fromEntries([...m].sort(([a], [b]) => a.localeCompare(b)));

describe("computeRecipients (CHAT-08)", () => {
  it("an explicit mention notifies the mentioned member", () => {
    expect(asObject(computeRecipients({ ...base, mentionedUserIds: [SAM] }))).toEqual({ [SAM]: "mention" });
  });

  it("the author mentioning himself notifies nobody", () => {
    expect(computeRecipients({ ...base, mentionedUserIds: [ADA] }).size).toBe(0);
  });

  it("a plain channel message notifies nobody", () => {
    expect(computeRecipients(base).size).toBe(0);
  });

  it("a DM notifies the other human", () => {
    expect(asObject(computeRecipients({ ...base, convKind: "dm", humanMemberIds: [ADA, SAM] }))).toEqual({
      [SAM]: "dm",
    });
  });

  it("a group notifies every other human; a mention there is stronger (strongest kind wins)", () => {
    const group = { ...base, convKind: "group" as const, humanMemberIds: [ADA, SAM, ALEX] };
    expect(asObject(computeRecipients(group))).toEqual({ [ALEX]: "group_dm", [SAM]: "group_dm" });
    expect(asObject(computeRecipients({ ...group, mentionedUserIds: [SAM] }))).toEqual({
      [ALEX]: "group_dm",
      [SAM]: "mention",
    });
  });

  it("a thread reply notifies the root author and earlier repliers, once each, never the author", () => {
    const r = computeRecipients({
      ...base,
      isThreadReply: true,
      threadParticipantIds: [SAM, ALEX, SAM, ADA],
    });
    expect(asObject(r)).toEqual({ [ALEX]: "thread_reply", [SAM]: "thread_reply" });
  });

  it("thread participants are ignored on a top-level message", () => {
    expect(computeRecipients({ ...base, threadParticipantIds: [SAM] }).size).toBe(0);
  });

  it("@channel notifies every other human member", () => {
    expect(asObject(computeRecipients({ ...base, mentionAll: "channel" }))).toEqual({
      [ALEX]: "channel",
      [SAM]: "channel",
    });
  });

  it("@here notifies only the other members online now", () => {
    const r = computeRecipients({ ...base, mentionAll: "here", onlineUserIds: new Set([ADA, SAM, BOB]) });
    expect(asObject(r)).toEqual({ [SAM]: "here" });
  });

  it("a mention beats @channel and a thread reply for the same person", () => {
    const r = computeRecipients({
      ...base,
      mentionAll: "channel",
      mentionedUserIds: [SAM],
      isThreadReply: true,
      threadParticipantIds: [SAM, ALEX],
    });
    expect(asObject(r)).toEqual({ [ALEX]: "channel", [SAM]: "mention" });
  });

  it("a mentioned user who is not a human member is still computed (access is decided by the service)", () => {
    expect(asObject(computeRecipients({ ...base, mentionedUserIds: [BOB] }))).toEqual({ [BOB]: "mention" });
  });

  it("a bot author (no author user) excludes nobody", () => {
    expect(
      asObject(computeRecipients({ ...base, authorUserId: null, convKind: "dm", humanMemberIds: [SAM] })),
    ).toEqual({ [SAM]: "dm" });
  });
});
