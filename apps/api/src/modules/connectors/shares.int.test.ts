import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertNoGlobalFetch,
  auditRows,
  type ConnectorsStack,
  connectOAuth,
  fails,
  type Json,
  join,
  ok,
  registerConnector,
  startConnectorsStack,
} from "../../testing-connectors";
import { activeShare } from "./index";

/**
 * Member-account shares (07.4-10 Task 3; D-03, CONN-03): a member allows their own account (a connection or a personal
 * key) in one conversation they can read, after seeing the reader count; audited and revocable in one call. Plus the
 * registry-derived organization-B case for every connector and share route (WINDOWS #169).
 */

let s: ConnectorsStack;
let crm: Json;
let samOnly: Json;
let ops: string; // a private channel of 5: Víctor, Sam, Alex, Jo, Kai
let samAlexDm: string;
let key: Json;
let share: Json;

const MOCK = { backend: "mock", provider: "mock", modelId: "mock-1" } as const;

const isActive = (
  userId: string,
  conversationId: string,
  resourceKind: "connector" | "vault_item",
  resourceId: string,
) =>
  s.stack.built.core.db.withTenant({ organizationId: s.orgA, userId }, (tx) =>
    activeShare(tx, { userId, conversationId, resourceKind, resourceId }),
  );

beforeAll(async () => {
  s = await startConnectorsStack();
  const [, joId] = await join(s, "jo@example.test", "Jo Diaz");
  const [, kaiId] = await join(s, "kai@example.test", "Kai Moe");
  crm = await registerConnector(s);
  samOnly = await registerConnector(s);
  expect((await connectOAuth(s, s.victor, crm.id)).status).toBe(302);
  expect((await connectOAuth(s, s.sam, samOnly.id)).status).toBe(302);
  const channel = await ok(
    s.victor.request("POST", "/api/v1/channels", { name: "ops", visibility: "private" }),
  );
  ops = channel.id;
  for (const id of [s.samId, s.alexId, joId, kaiId]) {
    await ok(s.victor.request("POST", `/api/v1/channels/${ops}/members`, { kind: "user", id }));
  }
  const dm = await ok(
    s.sam.request("POST", "/api/v1/dms", { participants: [{ kind: "user", id: s.alexId }] }),
  );
  samAlexDm = dm.id;
  key = await ok(
    s.victor.request("POST", "/api/v1/keychain", {
      scope: "personal",
      kind: "api_key",
      name: "ERP",
      value: "ERP-KEY-CANARY",
      allowedHosts: ["erp.example.com"],
    }),
    201,
  );
}, 240_000);

afterEach(() => {
  assertNoGlobalFetch(s);
});

afterAll(async () => {
  await s?.stop();
});

describe("allowing a member's account in one conversation", () => {
  it("previews the readers of a private channel of 5", async () => {
    expect(
      await ok(s.victor.request("GET", `/api/v1/member-account-shares/preview?conversationId=${ops}`)),
    ).toEqual({
      conversationId: ops,
      conversationName: "#ops",
      readers: 5,
      unbounded: false,
    });
  });

  it("allows his connection there: 201 with the reader count, audited, active", async () => {
    share = await ok(
      s.victor.request("POST", "/api/v1/member-account-shares", {
        conversationId: ops,
        resourceKind: "connector",
        resourceId: crm.id,
      }),
      201,
    );
    expect(share).toMatchObject({
      conversationId: ops,
      conversationName: "#ops",
      resourceKind: "connector",
      resourceId: crm.id,
      resourceName: crm.name,
      readersAtGrant: 5,
    });
    expect((await auditRows(s, s.orgA, ["member_account.shared"])).at(-1)).toMatchObject({
      user_id: s.victorId,
      metadata: { conversationId: ops, resourceKind: "connector", resourceId: crm.id, readers: 5 },
    });
    expect(await isActive(s.victorId, ops, "connector", crm.id)).toBe(true);
    // Only for that member: Sam has no share of his own there.
    expect(await isActive(s.samId, ops, "connector", crm.id)).toBe(false);
    const list = await ok(s.victor.request("GET", "/api/v1/member-account-shares"));
    expect(list.shares.map((x: Json) => x.id)).toEqual([share.id]);
  });

  it("a second active share of the same account in the same conversation is 409", async () => {
    await fails(
      s.victor.request("POST", "/api/v1/member-account-shares", {
        conversationId: ops,
        resourceKind: "connector",
        resourceId: crm.id,
      }),
      409,
      "share_exists",
    );
  });

  it("another member's connection, a conversation he cannot read, or a missing one → 404", async () => {
    await fails(
      s.victor.request("POST", "/api/v1/member-account-shares", {
        conversationId: ops,
        resourceKind: "connector",
        resourceId: samOnly.id,
      }),
      404,
    );
    await fails(
      s.victor.request("POST", "/api/v1/member-account-shares", {
        conversationId: samAlexDm,
        resourceKind: "connector",
        resourceId: crm.id,
      }),
      404,
    );
    await fails(
      s.victor.request("GET", `/api/v1/member-account-shares/preview?conversationId=${samAlexDm}`),
      404,
    );
    await fails(
      s.victor.request("POST", "/api/v1/member-account-shares", {
        conversationId: randomUUID(),
        resourceKind: "connector",
        resourceId: crm.id,
      }),
      404,
    );
  });

  it("his own personal key can be allowed; nobody else's", async () => {
    const k = await ok(
      s.victor.request("POST", "/api/v1/member-account-shares", {
        conversationId: ops,
        resourceKind: "vault_item",
        resourceId: key.id,
      }),
      201,
    );
    expect(k).toMatchObject({ resourceName: "ERP", readersAtGrant: 5 });
    await fails(
      s.sam.request("POST", "/api/v1/member-account-shares", {
        conversationId: ops,
        resourceKind: "vault_item",
        resourceId: key.id,
      }),
      404,
    );
    await ok(s.victor.request("DELETE", `/api/v1/member-account-shares/${k.id}`), 204);
  });

  it("Sam cannot revoke Víctor's share; Víctor revokes it in one call (audited, inactive at once)", async () => {
    await fails(s.sam.request("DELETE", `/api/v1/member-account-shares/${share.id}`), 404);
    expect(await isActive(s.victorId, ops, "connector", crm.id)).toBe(true);
    const res = await s.victor.request("DELETE", `/api/v1/member-account-shares/${share.id}`);
    expect(res.status).toBe(204);
    expect(await isActive(s.victorId, ops, "connector", crm.id)).toBe(false);
    expect((await auditRows(s, s.orgA, ["member_account.share_revoked"])).at(-1)).toMatchObject({
      metadata: { shareId: share.id },
    });
    await fails(s.victor.request("DELETE", `/api/v1/member-account-shares/${share.id}`), 404);
    expect((await ok(s.victor.request("GET", "/api/v1/member-account-shares"))).shares).toEqual([]);
  });

  it("a DM or group DM is named for the viewer by its other members, never left unnamed (WINDOWS #194)", async () => {
    const asSam = await ok(
      s.sam.request("GET", `/api/v1/member-account-shares/preview?conversationId=${samAlexDm}`),
    );
    expect(asSam).toMatchObject({ conversationName: "your private chat with Alex Kim", readers: 2 });
    const asAlex = await ok(
      s.alex.request("GET", `/api/v1/member-account-shares/preview?conversationId=${samAlexDm}`),
    );
    expect(asAlex.conversationName).toBe("your private chat with Sam Lee");
    const group = await ok(
      s.sam.request("POST", "/api/v1/dms", {
        participants: [
          { kind: "user", id: s.alexId },
          { kind: "user", id: s.victorId },
        ],
      }),
    );
    const shared = await ok(
      s.sam.request("POST", "/api/v1/member-account-shares", {
        conversationId: group.id,
        resourceKind: "connector",
        resourceId: samOnly.id,
      }),
      201,
    );
    expect(shared.conversationName).toBe("your group chat with Alex Kim and Víctor Ruiz");
    const listed = (await ok(s.sam.request("GET", "/api/v1/member-account-shares"))).shares;
    expect(listed.find((x: Json) => x.id === shared.id)?.conversationName).toBe(
      "your group chat with Alex Kim and Víctor Ruiz",
    );
    await ok(s.sam.request("DELETE", `/api/v1/member-account-shares/${shared.id}`), 204);
  });

  it("an AI chat shared with the organization reports an unbounded audience", async () => {
    const created = await ok(
      s.victor.request("POST", "/api/v1/ai-chats", {
        clientMessageId: `cm-${randomUUID()}`,
        body: "Hi",
        model: MOCK,
      }),
      201,
    );
    const chatId = created.chat.id as string;
    const before = await ok(
      s.victor.request("GET", `/api/v1/member-account-shares/preview?conversationId=${chatId}`),
    );
    expect(before).toMatchObject({ readers: 1, unbounded: false });
    await ok(
      s.victor.request("POST", `/api/v1/ai-chats/${chatId}/grants`, {
        subject: { kind: "org" },
        level: "view",
      }),
      201,
    );
    const after = await ok(
      s.victor.request("GET", `/api/v1/member-account-shares/preview?conversationId=${chatId}`),
    );
    expect(after).toMatchObject({ readers: 5, unbounded: true });
  });

  it("disconnecting revokes the member's shares of that connector", async () => {
    const again = await ok(
      s.victor.request("POST", "/api/v1/member-account-shares", {
        conversationId: ops,
        resourceKind: "connector",
        resourceId: crm.id,
      }),
      201,
    );
    expect((await s.victor.request("DELETE", `/api/v1/connectors/${crm.id}/connection`)).status).toBe(204);
    expect(await isActive(s.victorId, ops, "connector", crm.id)).toBe(false);
    expect((await auditRows(s, s.orgA, ["connector.disconnected"])).at(-1)).toMatchObject({
      metadata: { serverId: crm.id, sharesRevoked: 1 },
    });
    await fails(s.victor.request("DELETE", `/api/v1/member-account-shares/${again.id}`), 404);
  });
});

describe("organization B (WINDOWS #169)", () => {
  it("every connector and share route has an org-B case, and org B never reaches org A's rows", async () => {
    expect((await connectOAuth(s, s.victor, crm.id)).status).toBe(302);
    const aShare = await ok(
      s.victor.request("POST", "/api/v1/member-account-shares", {
        conversationId: ops,
        resourceKind: "connector",
        resourceId: crm.id,
      }),
      201,
    );
    const snapshot = async () =>
      JSON.stringify([
        (
          await s.su.query("select * from app.connector_connections where organization_id = $1 order by id", [
            s.orgA,
          ])
        ).rows,
        (
          await s.su.query("select * from app.member_account_shares where organization_id = $1 order by id", [
            s.orgA,
          ])
        ).rows,
        (
          await s.su.query(
            "select * from app.connector_oauth_clients where organization_id = $1 order by id",
            [s.orgA],
          )
        ).rows,
      ]);
    const before = await snapshot();
    const cases: Record<string, () => Promise<void>> = {
      "GET /api/v1/connectors": async () => {
        expect((await ok(s.eve.request("GET", "/api/v1/connectors"))).connectors).toEqual([]);
      },
      "POST /api/v1/connectors/:p/connect": async () => {
        await fails(s.eve.request("POST", `/api/v1/connectors/${crm.id}/connect`), 404);
      },
      "PUT /api/v1/connectors/:p/secret": async () => {
        await fails(s.eve.request("PUT", `/api/v1/connectors/${crm.id}/secret`, { value: "x" }), 404);
      },
      "DELETE /api/v1/connectors/:p/connection": async () => {
        await fails(s.eve.request("DELETE", `/api/v1/connectors/${crm.id}/connection`), 404);
      },
      "POST /api/v1/connectors/:p/probe": async () => {
        await fails(s.eve.request("POST", `/api/v1/connectors/${crm.id}/probe`), 404);
      },
      "GET /api/v1/connectors/oauth/callback": async () => {
        // Org A's flow, completed with org B's session: refused and consumed.
        const start = await ok(s.victor.request("POST", `/api/v1/connectors/${crm.id}/connect`));
        const state = new URL(start.authorizeUrl).searchParams.get("state");
        const res = await fetch(`${s.stack.baseUrl}/api/v1/connectors/oauth/callback?state=${state}&code=x`, {
          redirect: "manual",
          headers: { cookie: s.eve.cookieHeader },
        });
        await res.body?.cancel();
        expect(res.headers.get("location")).toContain("error=session_mismatch");
      },
      "GET /api/v1/connectors/oauth/client-metadata.json": async () => {
        // Instance-wide and public; this stack is plain http, so there is none.
        expect((await s.eve.request("GET", "/api/v1/connectors/oauth/client-metadata.json")).status).toBe(
          404,
        );
      },
      "GET /api/v1/member-account-shares": async () => {
        expect((await ok(s.eve.request("GET", "/api/v1/member-account-shares"))).shares).toEqual([]);
      },
      "GET /api/v1/member-account-shares/preview": async () => {
        await fails(s.eve.request("GET", `/api/v1/member-account-shares/preview?conversationId=${ops}`), 404);
      },
      "POST /api/v1/member-account-shares": async () => {
        await fails(
          s.eve.request("POST", "/api/v1/member-account-shares", {
            conversationId: ops,
            resourceKind: "connector",
            resourceId: crm.id,
          }),
          404,
        );
      },
      "DELETE /api/v1/member-account-shares/:p": async () => {
        await fails(s.eve.request("DELETE", `/api/v1/member-account-shares/${aShare.id}`), 404);
      },
    };
    const owned = (k: string) => {
      const path = k.split(" ")[1] ?? "";
      return path.startsWith("/api/v1/connectors") || path.startsWith("/api/v1/member-account-shares");
    };
    const routeKey = (k: string) => k.replace(/:[A-Za-z]+/gu, ":p");
    const registered = [...s.stack.built.authz.routes.keys()].filter(owned).map(routeKey).sort();
    expect(registered).toEqual(Object.keys(cases).sort());
    for (const [k, mode] of s.stack.built.authz.routes) {
      if (!owned(k)) continue;
      expect(mode, k).toBe(k.includes("/oauth/") ? "public" : "user");
    }
    for (const run of Object.values(cases)) await run();
    expect(await snapshot()).toBe(before);
  });
});
