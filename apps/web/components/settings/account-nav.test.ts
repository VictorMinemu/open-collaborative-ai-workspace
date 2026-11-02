import type { Permission } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { accountSections } from "./account-nav";

const ids = (grainsOff: readonly Permission[], keep: { connections: boolean; keychain: boolean }) =>
  accountSections((p) => grainsOff.includes(p), keep).map((s) => s.id);

const nothingToKeep = { connections: false, keychain: false };

describe("Settings › Account entries (07.3 module gating, 07.4 withdrawal: #196 and the 07.4 verification warning)", () => {
  it("everything is listed while every grain is on", () => {
    expect(ids([], nothingToKeep)).toEqual([
      "profile",
      "security",
      "notifications",
      "digest",
      "ai-chat",
      "connections",
      "keychain",
    ]);
  });

  it("Bots off with nothing of the member's own: Connections and Keychain leave", () => {
    expect(ids(["connector.connect", "vault.use", "automation.create"], nothingToKeep)).toEqual([
      "profile",
      "security",
      "notifications",
      "ai-chat",
    ]);
  });

  it("Bots off: Keychain stays while the member has keys to manage, so they can find and delete them", () => {
    expect(
      ids(["connector.connect", "vault.use", "automation.create"], { connections: false, keychain: true }),
    ).toEqual(["profile", "security", "notifications", "ai-chat", "keychain"]);
  });

  it("Bots off: Connections stays while the member has something to withdraw (#196)", () => {
    expect(ids(["connector.connect", "vault.use"], { connections: true, keychain: false })).toContain(
      "connections",
    );
  });

  it("Digest sits after Notifications and leaves with automations (Bots off, 07.6-16)", () => {
    expect(ids([], nothingToKeep).slice(2, 4)).toEqual(["notifications", "digest"]);
    expect(ids(["automation.create"], nothingToKeep)).not.toContain("digest");
  });

  it("keeping is per entry: keys never bring back AI chat or Connections", () => {
    expect(
      ids(["ai_chat.use", "connector.connect", "vault.use", "automation.create"], {
        connections: false,
        keychain: true,
      }),
    ).toEqual(["profile", "security", "notifications", "keychain"]);
  });
});
