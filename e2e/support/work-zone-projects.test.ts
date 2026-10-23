import type { APIRequestContext } from "@playwright/test";
import { describe, expect, it } from "vitest";
import {
  createTeamProject,
  linkRepo,
  removeTeamProject,
  setAudience,
  shareDevice,
} from "./work-zone-projects";

/**
 * 07.9-08: the e2e helpers that give a second person explicit access to a session (D-06, P-07) go through the public
 * API only. A stub request context records every call and answers from a per-route table, so the order, the bodies and
 * the error handling are checked without a stack.
 */

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = "2026-10-23T10:00:00.000Z";

type Call = { method: "GET" | "POST" | "PUT" | "DELETE"; url: string; data?: unknown };
type Reply = { status: number; body: unknown };

function stub(route: (call: Call) => Reply): { api: APIRequestContext; calls: Call[] } {
  const calls: Call[] = [];
  const respond = (call: Call) => {
    calls.push(call);
    const reply = route(call);
    return Promise.resolve({
      ok: () => reply.status >= 200 && reply.status < 300,
      status: () => reply.status,
      json: () => Promise.resolve(reply.body),
      text: () => Promise.resolve(JSON.stringify(reply.body)),
    });
  };
  const api = {
    get: (url: string) => respond({ method: "GET", url }),
    post: (url: string, opts?: { data?: unknown }) => respond({ method: "POST", url, data: opts?.data }),
    put: (url: string, opts?: { data?: unknown }) => respond({ method: "PUT", url, data: opts?.data }),
    delete: (url: string) => respond({ method: "DELETE", url }),
  };
  return { api: api as unknown as APIRequestContext, calls };
}

const unit = (
  id: string,
  kind: "department" | "team" | "project",
  name: string,
  parentId: string | null,
) => ({
  id,
  parentId,
  kind,
  name,
  path: parentId ? [parentId, id] : [id],
  memberCount: 0,
  leadCount: 0,
  viewerCan: [],
  createdAt: NOW,
  updatedAt: NOW,
});

const detail = (id: string, name: string, parentId: string) => ({
  id,
  name,
  parentId,
  trail: ["Parent"],
  defaultVisibility: "project",
  access: { count: 1, people: [] },
  teams: [],
  repos: [],
  viewerCan: { manage: true, assignTeams: true, members: true },
});

const member = (userId: string, role: string) => ({
  userId,
  displayName: "Sam Lee",
  avatarUrl: null,
  orgRole: "developer",
  role,
  status: "active",
  addedAt: NOW,
});

const apiError = (status: number, code: string): Reply => ({
  status,
  body: { error: { code, message: `refused: ${code}` } },
});

describe("createTeamProject()", () => {
  it("creates a department, the team project under it, then adds each member", async () => {
    const { api, calls } = stub((c) => {
      if (c.method === "GET" && c.url === "/api/v1/units")
        return { status: 200, body: { units: [], lastSeq: 0 } };
      if (c.method === "POST" && c.url === "/api/v1/units") {
        return { status: 200, body: unit(ID(1), "department", "Atlas department", null) };
      }
      if (c.method === "POST" && c.url === "/api/v1/work-projects") {
        return { status: 200, body: detail(ID(2), "Atlas", ID(1)) };
      }
      if (c.method === "POST" && c.url === `/api/v1/units/${ID(2)}/members`) {
        const d = c.data as { userId: string; role: string };
        return { status: 200, body: member(d.userId, d.role) };
      }
      return apiError(500, "unexpected");
    });

    const result = await createTeamProject(api, {
      name: "Atlas",
      members: [{ userId: ID(10) }, { userId: ID(11), role: "lead" }],
    });

    expect(result).toEqual({ unitId: ID(2), parentId: ID(1), ownParent: true });
    expect(calls).toEqual([
      { method: "GET", url: "/api/v1/units" },
      {
        method: "POST",
        url: "/api/v1/units",
        data: { kind: "department", name: "Atlas department", parentId: null },
      },
      { method: "POST", url: "/api/v1/work-projects", data: { name: "Atlas", parentId: ID(1) } },
      { method: "POST", url: `/api/v1/units/${ID(2)}/members`, data: { userId: ID(10), role: "member" } },
      { method: "POST", url: `/api/v1/units/${ID(2)}/members`, data: { userId: ID(11), role: "lead" } },
    ]);
  });

  it("puts the project under an existing unit named by parentName, without creating a department", async () => {
    const { api, calls } = stub((c) => {
      if (c.method === "GET" && c.url === "/api/v1/units") {
        return { status: 200, body: { units: [unit(ID(5), "team", "Backend", null)], lastSeq: 3 } };
      }
      if (c.method === "POST" && c.url === "/api/v1/work-projects") {
        return { status: 200, body: detail(ID(6), "Billing", ID(5)) };
      }
      return apiError(500, "unexpected");
    });

    const result = await createTeamProject(api, { name: "Billing", parentName: "Backend", members: [] });

    expect(result).toEqual({ unitId: ID(6), parentId: ID(5), ownParent: false });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/v1/units",
      "POST /api/v1/work-projects",
    ]);
  });

  it("tolerates a person who is already a member (the creator joins as lead automatically)", async () => {
    const { api } = stub((c) => {
      if (c.method === "GET") return { status: 200, body: { units: [], lastSeq: 0 } };
      if (c.url === "/api/v1/units")
        return { status: 200, body: unit(ID(1), "department", "X department", null) };
      if (c.url === "/api/v1/work-projects") return { status: 200, body: detail(ID(2), "X", ID(1)) };
      return apiError(409, "already_member");
    });

    await expect(createTeamProject(api, { name: "X", members: [{ userId: ID(10) }] })).resolves.toEqual({
      unitId: ID(2),
      parentId: ID(1),
      ownParent: true,
    });
  });

  it("reuses a project that already exists under the parent (a retried test), never a second one", async () => {
    const { api, calls } = stub((c) => {
      if (c.method === "GET") {
        return {
          status: 200,
          body: {
            units: [
              unit(ID(1), "department", "Atlas department", null),
              unit(ID(2), "project", "Atlas", ID(1)),
            ],
            lastSeq: 9,
          },
        };
      }
      return { status: 200, body: member(ID(10), "member") };
    });

    const result = await createTeamProject(api, { name: "Atlas", members: [{ userId: ID(10) }] });

    expect(result).toEqual({ unitId: ID(2), parentId: ID(1), ownParent: true });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/v1/units",
      `POST /api/v1/units/${ID(2)}/members`,
    ]);
  });

  it("throws with the status and the error code on a refusal", async () => {
    const { api } = stub((c) => {
      if (c.method === "GET") return { status: 200, body: { units: [], lastSeq: 0 } };
      if (c.url === "/api/v1/units")
        return { status: 200, body: unit(ID(1), "department", "Y department", null) };
      return apiError(403, "missing_permission");
    });

    await expect(createTeamProject(api, { name: "Y", members: [] })).rejects.toThrow(
      /POST \/api\/v1\/work-projects.*403.*missing_permission/u,
    );
  });

  it("throws on a member refusal other than already_member", async () => {
    const { api } = stub((c) => {
      if (c.method === "GET") return { status: 200, body: { units: [], lastSeq: 0 } };
      if (c.url === "/api/v1/units")
        return { status: 200, body: unit(ID(1), "department", "Z department", null) };
      if (c.url === "/api/v1/work-projects") return { status: 200, body: detail(ID(2), "Z", ID(1)) };
      return apiError(400, "lead_role_required");
    });

    await expect(
      createTeamProject(api, { name: "Z", members: [{ userId: ID(10), role: "lead" }] }),
    ).rejects.toThrow(/400.*lead_role_required/u);
  });
});

describe("linkRepo()", () => {
  it("issues one POST /work-projects/:unitId/repos with the repository id", async () => {
    const { api, calls } = stub(() => ({ status: 200, body: detail(ID(2), "Atlas", ID(1)) }));

    await linkRepo(api, ID(2), ID(30));

    expect(calls).toEqual([
      { method: "POST", url: `/api/v1/work-projects/${ID(2)}/repos`, data: { projectId: ID(30) } },
    ]);
  });

  it("throws with the status and the error code on a refusal", async () => {
    const { api } = stub(() => apiError(409, "repo_already_linked"));

    await expect(linkRepo(api, ID(2), ID(30))).rejects.toThrow(/409.*repo_already_linked/u);
  });
});

describe("removeTeamProject()", () => {
  const repo = (projectId: string) => ({
    projectId,
    name: "acme",
    deviceId: ID(40),
    deviceName: "E2E Mac",
    deviceOnline: false,
    branch: null,
    available: false,
  });

  it("unlinks every repository, deletes the project, then the department the helper named", async () => {
    const { api, calls } = stub((c) => {
      if (c.method === "GET") {
        return {
          status: 200,
          body: { ...detail(ID(2), "Atlas", ID(1)), repos: [repo(ID(30)), repo(ID(31))] },
        };
      }
      if (c.method === "DELETE" && c.url.includes("/repos/"))
        return { status: 200, body: detail(ID(2), "Atlas", ID(1)) };
      return { status: 200, body: { ok: true } };
    });

    await removeTeamProject(api, { unitId: ID(2), parentId: ID(1), ownParent: true });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /api/v1/work-projects/${ID(2)}`,
      `DELETE /api/v1/work-projects/${ID(2)}/repos/${ID(30)}`,
      `DELETE /api/v1/work-projects/${ID(2)}/repos/${ID(31)}`,
      `DELETE /api/v1/units/${ID(2)}`,
      `DELETE /api/v1/units/${ID(1)}`,
    ]);
  });

  it("never deletes a parent it did not name, and keeps a department that still holds other units", async () => {
    const reply = (c: Call): Reply => {
      if (c.method === "GET") return { status: 200, body: detail(ID(2), "Atlas", ID(1)) };
      if (c.url === `/api/v1/units/${ID(1)}`) return apiError(409, "unit_has_children");
      return { status: 200, body: { ok: true } };
    };
    const kept = stub(reply);
    await removeTeamProject(kept.api, { unitId: ID(2), parentId: ID(1), ownParent: false });
    expect(kept.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /api/v1/work-projects/${ID(2)}`,
      `DELETE /api/v1/units/${ID(2)}`,
    ]);

    const busy = stub(reply);
    await expect(
      removeTeamProject(busy.api, { unitId: ID(2), parentId: ID(1), ownParent: true }),
    ).resolves.toBeUndefined();
  });

  it("is a no-op for a project that is already gone, and throws on any other refusal", async () => {
    const gone = stub(() => apiError(404, "not_found"));
    await expect(
      removeTeamProject(gone.api, { unitId: ID(2), parentId: ID(1), ownParent: true }),
    ).resolves.toBeUndefined();
    expect(gone.calls).toHaveLength(1);

    const refusedDelete = stub((c) =>
      c.method === "GET"
        ? { status: 200, body: detail(ID(2), "Atlas", ID(1)) }
        : apiError(409, "unit_has_bots"),
    );
    await expect(
      removeTeamProject(refusedDelete.api, { unitId: ID(2), parentId: ID(1), ownParent: true }),
    ).rejects.toThrow(/DELETE \/api\/v1\/units\/.*409.*unit_has_bots/u);
  });
});

describe("shareDevice()", () => {
  it("puts a user grant on the device at the default cap unless a cap is given", async () => {
    const grant = (maxMode: string) => ({
      principalKind: "user",
      principalId: ID(10),
      principalName: "Sam Lee",
      maxMode,
      createdAt: NOW,
    });
    const { api, calls } = stub((c) => ({
      status: 200,
      body: grant((c.data as { maxMode: string }).maxMode),
    }));

    await shareDevice(api, ID(40), ID(10));
    await shareDevice(api, ID(40), ID(10), "acceptEdits");

    expect(calls).toEqual([
      { method: "PUT", url: `/api/v1/devices/${ID(40)}/grants/user/${ID(10)}`, data: { maxMode: "default" } },
      {
        method: "PUT",
        url: `/api/v1/devices/${ID(40)}/grants/user/${ID(10)}`,
        data: { maxMode: "acceptEdits" },
      },
    ]);
  });

  it("throws with the status and the error code on a refusal", async () => {
    const { api } = stub(() => apiError(409, "device_opt_in"));

    await expect(shareDevice(api, ID(40), ID(10), "fullAccess")).rejects.toThrow(/409.*device_opt_in/u);
  });
});

describe("setAudience()", () => {
  const view = {
    kind: "people",
    projectDefault: "project",
    project: { kind: "team", id: ID(7), name: "Atlas" },
    owner: { userId: ID(1), name: "Ana Ruiz" },
    teams: [],
    people: [{ userId: ID(2), name: "Leo Park", avatarUrl: null, active: true }],
    viewers: { count: 2, people: [], more: 0 },
    alwaysVisible: { admins: true, deviceOwner: null },
    viewerCan: { change: true },
    viewerState: null,
  };

  it("puts the audience on the session and returns who lost access", async () => {
    const { api, calls } = stub(() => ({
      status: 200,
      body: { visibility: view, removedCount: 1, removedNames: ["Sam Lee"] },
    }));
    const result = await setAudience(api, ID(9), { kind: "people", userIds: [ID(2)] });
    expect(calls).toEqual([
      {
        method: "PUT",
        url: `/api/v1/work-sessions/${ID(9)}/visibility`,
        data: { kind: "people", userIds: [ID(2)] },
      },
    ]);
    expect(result.removedCount).toBe(1);
    expect(result.visibility.kind).toBe("people");
  });

  it("throws with the status and the error code on a refusal", async () => {
    const { api } = stub(() => apiError(422, "audience_outside_project"));
    await expect(setAudience(api, ID(9), { kind: "owner" })).rejects.toThrow(
      `PUT /api/v1/work-sessions/${ID(9)}/visibility: HTTP 422 audience_outside_project`,
    );
  });
});
