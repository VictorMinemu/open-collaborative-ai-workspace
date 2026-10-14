import type { DmSummary, MemberConnector } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import {
  connectionDate,
  connectorErrorSentence,
  connectorView,
  conversationLabel,
  readersLine,
  reprobeRefusal,
  withdrawalView,
} from "./connections-format";

const NOW = Date.parse("2026-10-13T12:00:00Z");

function connector(over: Partial<MemberConnector> = {}): MemberConnector {
  return {
    serverId: "00000000-0000-4000-8000-000000000001",
    name: "Acme CRM",
    safeName: "acme_crm",
    authMode: "per_member_oauth",
    status: "not_connected",
    connectedAt: null,
    lastUsedAt: null,
    scopes: [],
    oauthStatus: null,
    secretHeaderName: null,
    secretHeaderPrefix: null,
    accountLabel: null,
    reconnectReason: null,
    ...over,
  };
}

describe("connectionDate", () => {
  it("says today, yesterday, a short date, and the year outside the current one", () => {
    expect(connectionDate("2026-10-13T08:00:00Z", NOW)).toBe("today");
    expect(connectionDate("2026-10-12T08:00:00Z", NOW)).toBe("yesterday");
    expect(connectionDate("2026-10-08T08:00:00Z", NOW)).toBe("Oct 8");
    expect(connectionDate("2025-10-08T08:00:00Z", NOW)).toBe("Oct 8, 2025");
  });
});

describe("connectorView (UI-SPEC § 2 state table)", () => {
  it("not connected: sign in or add a key", () => {
    expect(connectorView(connector(), { oauthAvailable: true }, NOW)).toMatchObject({
      status: "not_connected",
      pill: "Not connected",
      meta: "Sign in once. Bots use it only when you ask.",
      primary: { kind: "connect", label: "Connect" },
      secondary: [],
    });
    expect(
      connectorView(connector({ authMode: "per_member_secret" }), { oauthAvailable: false }, NOW),
    ).toMatchObject({
      status: "not_connected",
      meta: "Add your own key. It's never shown again.",
      primary: { kind: "key", label: "Add your key" },
    });
  });

  it("connected: the account, since when and last use", () => {
    const c = connector({
      status: "connected",
      connectedAt: "2026-10-13T09:00:00Z",
      accountLabel: "ana@acme.com",
      lastUsedAt: "2026-10-13T11:55:00Z",
    });
    expect(connectorView(c, { oauthAvailable: true }, NOW)).toMatchObject({
      status: "connected",
      pill: "Connected",
      meta: "as ana@acme.com · since today · last used 5 minutes ago",
      primary: null,
      secondary: ["disconnect"],
    });
    expect(
      connectorView({ ...c, accountLabel: null, lastUsedAt: null }, { oauthAvailable: true }, NOW).meta,
    ).toBe("since today · never used");
    const key = connector({
      authMode: "per_member_secret",
      status: "connected",
      connectedAt: "2026-10-13T09:00:00Z",
    });
    expect(connectorView(key, { oauthAvailable: true }, NOW)).toMatchObject({
      meta: "Key set · since today · never used",
      primary: null,
      secondary: ["replace", "disconnect"],
    });
  });

  it("needs reconnect and access revoked are told apart by reconnectReason (R2)", () => {
    const expired = connector({ status: "needs_reconnect", reconnectReason: "expired" });
    expect(connectorView(expired, { oauthAvailable: true }, NOW)).toMatchObject({
      status: "needs_reconnect",
      pill: "Needs reconnect",
      meta: "Your sign-in expired. Bots can't use it until you reconnect.",
      primary: { kind: "connect", label: "Reconnect" },
      secondary: ["disconnect"],
    });
    const revoked = connector({ status: "needs_reconnect", reconnectReason: "revoked" });
    expect(connectorView(revoked, { oauthAvailable: true }, NOW)).toMatchObject({
      status: "revoked",
      pill: "Access revoked",
      meta: "Access was revoked at Acme CRM. Reconnect to use it again.",
      primary: { kind: "connect", label: "Reconnect" },
    });
    const key = connector({ authMode: "per_member_secret", status: "needs_reconnect" });
    expect(connectorView(key, { oauthAvailable: true }, NOW)).toMatchObject({
      meta: "Your key stopped working. Add a new one to keep using it.",
      primary: { kind: "key", label: "Add a new key" },
    });
  });

  it("unavailable: no HTTPS, or an admin has to finish the set-up; Connect stays visible but disabled", () => {
    expect(connectorView(connector(), { oauthAvailable: false }, NOW)).toMatchObject({
      status: "unavailable",
      pill: "Not connected",
      meta: "Sign-in needs HTTPS on this workspace.",
      primary: { kind: "connect", label: "Connect", disabled: true },
    });
    for (const oauthStatus of ["needs_client", "error"] as const) {
      expect(connectorView(connector({ oauthStatus }), { oauthAvailable: true }, NOW)).toMatchObject({
        status: "unavailable",
        meta: "Not ready yet. An admin has to finish setting up Acme CRM.",
        primary: { disabled: true },
      });
    }
  });
});

describe("connectorErrorSentence (fixed sentences, never provider text)", () => {
  it("names the connector and says what to do", () => {
    expect(connectorErrorSentence("access_denied", "Acme CRM")).toEqual({
      text: "You didn't allow access at Acme CRM.",
      retry: true,
    });
    expect(connectorErrorSentence("session_mismatch", "Acme CRM").text).toBe(
      "This sign-in was started from another account. Try again.",
    );
    expect(connectorErrorSentence("https_required", "Acme CRM")).toEqual({
      text: "Signing in needs HTTPS on this workspace. Ask an admin to set it up.",
      retry: false,
    });
    for (const code of ["needs_client", "pkce_unsupported", "egress_refused"]) {
      expect(connectorErrorSentence(code, "Acme CRM").retry).toBe(false);
    }
  });

  it("an unknown code (or a provider's own) reads as the generic sentence", () => {
    expect(connectorErrorSentence("<script>alert(1)</script>", "Acme CRM")).toEqual({
      text: "Couldn't connect Acme CRM. Try again.",
      retry: true,
    });
  });
});

describe("conversationLabel", () => {
  const dms = [
    {
      id: "dm-1",
      counterpart: {
        kind: "user",
        id: "u",
        name: "Sam Lee",
        handle: "sam",
        avatarUrl: null,
        deactivated: false,
      },
    },
    {
      id: "dm-2",
      counterpart: {
        kind: "group",
        name: "Ana, Sam",
        members: [
          { kind: "user", id: "a", name: "Ana", avatarUrl: null },
          { kind: "user", id: "s", name: "Sam", avatarUrl: null },
        ],
      },
    },
    {
      id: "dm-3",
      counterpart: {
        kind: "agent",
        id: "b",
        name: "Scout",
        username: "scout",
        avatarUrl: null,
        status: "ready",
        scope: "personal",
      },
    },
  ] as unknown as DmSummary[];

  it("uses the API's name, then the DM or group the member can open, and only then the unknown sentence", () => {
    expect(conversationLabel("c", "#ops", dms)).toBe("#ops");
    expect(conversationLabel("dm-1", null, dms)).toBe("your private chat with Sam Lee");
    expect(conversationLabel("dm-2", null, dms)).toBe("your group chat with Ana, Sam");
    expect(conversationLabel("dm-3", null, dms)).toBe("your private chat with Scout");
    expect(conversationLabel("gone", null, dms)).toBe("a conversation you can no longer open");
    expect(conversationLabel("dm-1", null, undefined)).toBe("a conversation you can no longer open");
  });
});

describe("readersLine", () => {
  it("pluralises and names the group of an unbounded audience", () => {
    expect(readersLine({ readers: 5, unbounded: false }, null)).toBe("5 people can read results here");
    expect(readersLine({ readers: 1, unbounded: false }, null)).toBe("1 person can read results here");
    expect(readersLine({ readers: 40, unbounded: true }, null)).toBe(
      "Everyone in the organization can read results here",
    );
    expect(readersLine({ readers: 40, unbounded: true }, "Backend")).toBe(
      "Everyone in Backend can read results here",
    );
  });
});

describe("withdrawalView (connecting denied, e.g. Bots off: WINDOWS #196)", () => {
  it("keeps the state and the meta line, offers Disconnect only, never a connect, reconnect or replace", () => {
    const oauth = { oauthAvailable: true };
    const key = withdrawalView(
      connectorView(
        connector({
          authMode: "per_member_secret",
          status: "connected",
          connectedAt: "2026-10-13T08:00:00Z",
        }),
        oauth,
        NOW,
      ),
    );
    expect(key).toMatchObject({
      status: "connected",
      pill: "Connected",
      primary: null,
      secondary: ["disconnect"],
    });
    expect(key.meta).toBe("Key set · since today · never used");
    const revoked = withdrawalView(
      connectorView(connector({ status: "needs_reconnect", reconnectReason: "revoked" }), oauth, NOW),
    );
    expect(revoked).toMatchObject({ status: "revoked", primary: null, secondary: ["disconnect"] });
    expect(withdrawalView(connectorView(connector(), oauth, NOW))).toMatchObject({
      primary: null,
      secondary: [],
    });
  });
});

describe("reprobeRefusal (per-member Re-probe without a working connection: WINDOWS #196)", () => {
  it("asks to connect when there is no connection and to reconnect when the sign-in stopped working", () => {
    expect(reprobeRefusal("not_connected", "Acme CRM")).toBe("Connect your own Acme CRM account first");
    expect(reprobeRefusal("needs_reconnect", "Acme CRM")).toBe("Reconnect your own Acme CRM account first");
  });
});
