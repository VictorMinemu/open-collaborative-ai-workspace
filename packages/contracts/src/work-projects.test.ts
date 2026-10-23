import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as workProjects from "./work-projects";
import {
  AssignableTeams,
  AssignWorkProjectTeamRequest,
  CreateWorkProjectRequest,
  LinkableRepos,
  LinkWorkProjectRepoRequest,
  RepoUnlinkImpact,
  UpdateWorkProjectRequest,
  WORK_PROJECT_LIMITS,
  WorkProjectDetail,
  WorkProjectIndex,
  WorkProjectParents,
  WorkProjectSearchQuery,
  WorkProjectTeam,
  WorkProjectUpdatedEvent,
} from "./work-projects";

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const person = (n: number) => ({ userId: uuid(n), name: `Person ${n}`, avatarUrl: null });

const detail = {
  id: uuid(1),
  name: "Customer portal",
  parentId: uuid(2),
  trail: ["Engineering", "Web"],
  defaultVisibility: "project",
  access: { count: 14, people: [1, 2, 3, 4, 5].map((n) => person(10 + n)) },
  teams: [
    { id: uuid(3), name: "Web", kind: "team", memberCount: 8 },
    { id: uuid(4), name: "Design", kind: "department", memberCount: 6 },
  ],
  repos: [
    {
      projectId: uuid(5),
      name: "web-app",
      deviceId: uuid(6),
      deviceName: "Ana's MacBook",
      deviceOnline: true,
      branch: "main",
      available: true,
    },
  ],
  viewerCan: { manage: true, assignTeams: false, members: true },
};

describe("team project API contracts (07.9-01, D-01, D-10, D-13)", () => {
  it("CreateWorkProjectRequest trims the name, bounds it to 1..80 and refuses unknown keys", () => {
    expect(CreateWorkProjectRequest.parse({ name: "  Customer portal ", parentId: uuid(2) })).toEqual({
      name: "Customer portal",
      parentId: uuid(2),
    });
    expect(CreateWorkProjectRequest.safeParse({ name: "", parentId: uuid(2) }).success).toBe(false);
    expect(CreateWorkProjectRequest.safeParse({ name: "   ", parentId: uuid(2) }).success).toBe(false);
    expect(CreateWorkProjectRequest.safeParse({ name: "x".repeat(81), parentId: uuid(2) }).success).toBe(
      false,
    );
    expect(CreateWorkProjectRequest.safeParse({ name: "x".repeat(80), parentId: uuid(2) }).success).toBe(
      true,
    );
    // No top level (D-13): a project always sits under a team or department.
    expect(CreateWorkProjectRequest.safeParse({ name: "x", parentId: null }).success).toBe(false);
    expect(CreateWorkProjectRequest.safeParse({ name: "x" }).success).toBe(false);
    expect(
      CreateWorkProjectRequest.safeParse({ name: "x", parentId: uuid(2), kind: "project" }).success,
    ).toBe(false);
  });

  it("UpdateWorkProjectRequest takes only project | owner", () => {
    expect(UpdateWorkProjectRequest.parse({ defaultVisibility: "owner" })).toEqual({
      defaultVisibility: "owner",
    });
    expect(UpdateWorkProjectRequest.safeParse({ defaultVisibility: "teams" }).success).toBe(false);
    expect(UpdateWorkProjectRequest.safeParse({}).success).toBe(false);
    expect(UpdateWorkProjectRequest.safeParse({ defaultVisibility: "project", name: "x" }).success).toBe(
      false,
    );
  });

  it("assign and link requests refuse unknown keys", () => {
    expect(AssignWorkProjectTeamRequest.parse({ unitId: uuid(3) })).toEqual({ unitId: uuid(3) });
    expect(AssignWorkProjectTeamRequest.safeParse({ unitId: uuid(3), role: "lead" }).success).toBe(false);
    expect(LinkWorkProjectRepoRequest.parse({ projectId: uuid(5) })).toEqual({ projectId: uuid(5) });
    expect(LinkWorkProjectRepoRequest.safeParse({ projectId: uuid(5), path: "/Users/a" }).success).toBe(
      false,
    );
  });

  it("WorkProjectDetail parses and refuses six access people", () => {
    expect(WorkProjectDetail.parse(detail).access.people).toHaveLength(WORK_PROJECT_LIMITS.accessPeople);
    const six = { ...detail, access: { count: 14, people: [1, 2, 3, 4, 5, 6].map((n) => person(10 + n)) } };
    expect(WorkProjectDetail.safeParse(six).success).toBe(false);
    expect(WorkProjectDetail.safeParse({ ...detail, defaultVisibility: "teams" }).success).toBe(false);
  });

  it("a team is a team or department, never a project", () => {
    expect(
      WorkProjectTeam.safeParse({ id: uuid(3), name: "P", kind: "project", memberCount: 1 }).success,
    ).toBe(false);
    expect(AssignableTeams.parse({ teams: detail.teams }).teams).toHaveLength(2);
  });

  it("the index, parents, linkable repos, impact and event parse", () => {
    expect(
      WorkProjectIndex.parse({
        teamProjects: [
          { id: uuid(1), name: "Customer portal", trail: ["Engineering"], peopleCount: 12, repoCount: 2 },
        ],
        personalRepos: [
          { projectId: uuid(7), name: "scratch", deviceId: uuid(6), deviceName: "Mac", deviceOnline: false },
        ],
        viewerCan: { create: true },
      }).teamProjects,
    ).toHaveLength(1);
    expect(
      WorkProjectParents.parse({
        parents: [{ id: uuid(2), name: "Web", kind: "team", trail: ["Engineering"] }],
      }).parents,
    ).toHaveLength(1);
    expect(
      WorkProjectParents.safeParse({ parents: [{ id: uuid(2), name: "P", kind: "project", trail: [] }] })
        .success,
    ).toBe(false);
    for (const linkedTo of [null, { id: uuid(1), name: "Customer portal" }]) {
      const linkable = {
        devices: [
          {
            deviceId: uuid(6),
            deviceName: "Ana's MacBook",
            deviceOnline: true,
            repos: [{ projectId: uuid(5), name: "web-app", linkedTo }],
          },
        ],
      };
      expect(LinkableRepos.parse(linkable).devices[0]?.repos[0]?.linkedTo).toEqual(linkedTo);
    }
    expect(RepoUnlinkImpact.parse({ sessions: 3 })).toEqual({ sessions: 3 });
    expect(RepoUnlinkImpact.safeParse({ sessions: -1 }).success).toBe(false);
    expect(WorkProjectUpdatedEvent.parse({ unitId: uuid(1) })).toEqual({ unitId: uuid(1) });
    expect(Object.keys(WorkProjectUpdatedEvent.shape)).toEqual(["unitId"]);
  });

  it("the search query is trimmed and bounded", () => {
    expect(WorkProjectSearchQuery.parse({ q: "  ana " })).toEqual({ q: "ana" });
    expect(WorkProjectSearchQuery.parse({})).toEqual({});
    expect(
      WorkProjectSearchQuery.safeParse({ q: "x".repeat(WORK_PROJECT_LIMITS.searchQueryMax + 1) }).success,
    ).toBe(false);
  });

  it("no schema carries a host path (principle 7): no key named path, localPath or absolutePath", () => {
    const forbidden = new Set(["path", "localPath", "absolutePath"]);
    const seen = new Set<z.ZodType>();
    const keys: string[] = [];
    const walk = (schema: z.ZodType): void => {
      if (seen.has(schema)) return;
      seen.add(schema);
      if (schema instanceof z.ZodObject) {
        for (const [key, child] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
          keys.push(key);
          walk(child);
        }
      } else if (schema instanceof z.ZodArray) {
        walk(schema.element as z.ZodType);
      } else if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
        walk(schema.unwrap() as z.ZodType);
      } else if (schema instanceof z.ZodUnion) {
        for (const option of schema.options) walk(option as z.ZodType);
      }
    };
    let objects = 0;
    for (const value of Object.values(workProjects)) {
      if (value instanceof z.ZodType) {
        if (value instanceof z.ZodObject) objects++;
        walk(value);
      }
    }
    // Every request and response of the project API is walked (and the walk really reaches nested keys).
    expect(objects).toBeGreaterThanOrEqual(15);
    expect(keys).toEqual(expect.arrayContaining(["linkedTo", "deviceOnline", "avatarUrl"]));
    expect(keys.filter((k) => forbidden.has(k))).toEqual([]);
  });
});
