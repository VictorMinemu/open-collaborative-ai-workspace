import type { Project } from "@ocw/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/lib/api";
import {
  AddServerLink,
  audienceRefusal,
  preselectedRepo,
  runtimeCardState,
  settingsSummary,
  startBlocker,
  stepRadio,
  whoUpdates,
} from "./new-session-dialog";

/**
 * A refused create request words the stale draft with the names the dialog showed (07.9-14, UI-SPEC Copy "Refusal
 * (inline)", D-04, D-13). The API sends entry ids only (07.9-06); the names come from the draft.
 */

const LEO = "01a11635-d6e7-7c87-9f17-0000000000a2";
const PIA = "01a11635-d6e7-7c87-9f17-0000000000a3";
const SAM = "01a11635-d6e7-7c87-9f17-0000000000a4";
const WEB = "01a11635-d6e7-7c87-9f17-0000000000d1";
const OPS = "01a11635-d6e7-7c87-9f17-0000000000d2";

const team = {
  deviceName: "Ana's MacBook",
  teamProject: {
    id: "01a11635-d6e7-7c87-9f17-0000000000e1",
    name: "Customer portal",
    defaultVisibility: "project" as const,
  },
};
const personal = { deviceName: "Ana's MacBook", teamProject: null };
const person = (userId: string, name: string) => ({ userId, name, avatarUrl: null });
const people = {
  kind: "people" as const,
  people: [person(LEO, "Leo Park"), person(PIA, "Pia Gómez"), person(SAM, "Sam Lee")],
};
const refused = (code: string, ids: string[]) =>
  new ApiRequestError(422, code, "Only people with access to the project can be chosen", { ids });

describe("audienceRefusal", () => {
  it("names the person who left the project", () => {
    expect(audienceRefusal(refused("audience_outside_project", [LEO]), people, team)).toBe(
      "Leo Park isn't in Customer portal anymore. Choose who can see it again.",
    );
  });

  it("names two, then two and a count", () => {
    expect(audienceRefusal(refused("audience_outside_project", [LEO, PIA]), people, team)).toBe(
      "Leo Park and Pia Gómez aren't in Customer portal anymore. Choose who can see it again.",
    );
    expect(audienceRefusal(refused("audience_outside_project", [LEO, PIA, SAM]), people, team)).toBe(
      "Leo Park, Pia Gómez and 1 more aren't in Customer portal anymore. Choose who can see it again.",
    );
  });

  it("on a personal repository, says who can't use the device anymore", () => {
    expect(audienceRefusal(refused("audience_outside_project", [PIA]), people, personal)).toBe(
      "Pia Gómez can't use Ana's MacBook anymore. Choose who can see it again.",
    );
  });

  it("names a team no longer assigned to the project", () => {
    const teams = {
      kind: "teams" as const,
      teams: [
        { id: WEB, name: "Web" },
        { id: OPS, name: "Ops" },
      ],
    };
    expect(audienceRefusal(refused("team_not_assigned", [OPS]), teams, team)).toBe(
      "Ops isn't assigned to Customer portal anymore. Choose who can see it again.",
    );
  });

  it("leaves every other error to the API's own message", () => {
    expect(audienceRefusal(new ApiRequestError(403, "forbidden", "No"), people, team)).toBeNull();
    expect(audienceRefusal(new Error("boom"), people, team)).toBeNull();
    expect(audienceRefusal(refused("audience_outside_project", ["unknown"]), people, team)).toBeNull();
    expect(audienceRefusal(refused("audience_outside_project", [LEO]), { kind: "project" }, team)).toBeNull();
    expect(
      audienceRefusal(new ApiRequestError(422, "audience_outside_project", "x", null), people, team),
    ).toBeNull();
  });
});

/**
 * What the dialog preselects (07.10-05, R5, D-14): a repository id keeps the 07.9 rule; a team project picks that
 * project's first online repository the viewer can start on, else its first; a hidden project's repository is never
 * preselected; a target the viewer may not use falls back to the default, never forced.
 */
describe("preselectedRepo", () => {
  const PORTAL_ID = "01a11635-d6e7-7c87-9f17-0000000000e1";
  const BILLING_ID = "01a11635-d6e7-7c87-9f17-0000000000e2";
  const repo = (id: string, over: Partial<Project> = {}): Project => ({
    id: `01a11635-d6e7-7c87-9f17-0000000000${id}`,
    deviceId: "01a11635-d6e7-7c87-9f17-0000000000c1",
    deviceName: "Ana's MacBook",
    deviceOnline: true,
    name: `repo-${id}`,
    gitRemote: null,
    defaultBranch: "main",
    available: true,
    createdAt: "2026-10-22T10:00:00Z",
    teamProject: null,
    ...over,
  });
  const portal = { id: PORTAL_ID, name: "Customer portal", defaultVisibility: "project" as const };
  const billing = { id: BILLING_ID, name: "Billing ops", defaultVisibility: "project" as const };
  const offlinePortal = repo("b1", { teamProject: portal, deviceOnline: false });
  const onlinePortal = repo("b2", { teamProject: portal });
  const billingRepo = repo("b3", { teamProject: billing });
  const scratch = repo("b4");
  const hidden = repo("b5", { teamProjectHidden: true });

  it("without a target: the first online repository the viewer can start on, else the first", () => {
    expect(preselectedRepo([hidden, offlinePortal, scratch], undefined)).toBe(scratch.id);
    expect(preselectedRepo([hidden, offlinePortal], undefined)).toBe(offlinePortal.id);
    expect(preselectedRepo([hidden], undefined)).toBeNull();
    expect(preselectedRepo([], undefined)).toBeNull();
  });

  it("a repository id keeps today's rule; a hidden project's repository is never preselected", () => {
    expect(preselectedRepo([scratch, offlinePortal], offlinePortal.id)).toBe(offlinePortal.id);
    expect(preselectedRepo([scratch, hidden], hidden.id)).toBe(scratch.id);
    expect(preselectedRepo([scratch], "01a11635-d6e7-7c87-9f17-00000000dead")).toBe(scratch.id);
  });

  it("a team project: its first online repository, else its first", () => {
    const all = [scratch, offlinePortal, billingRepo, onlinePortal];
    expect(preselectedRepo(all, { teamProjectId: PORTAL_ID })).toBe(onlinePortal.id);
    expect(preselectedRepo([scratch, offlinePortal, billingRepo], { teamProjectId: PORTAL_ID })).toBe(
      offlinePortal.id,
    );
    expect(preselectedRepo(all, { teamProjectId: BILLING_ID })).toBe(billingRepo.id);
  });

  it("a team project with no repository the viewer can use falls back to the default", () => {
    expect(preselectedRepo([offlinePortal, scratch], { teamProjectId: BILLING_ID })).toBe(scratch.id);
    expect(preselectedRepo([hidden, scratch], { teamProjectId: PORTAL_ID })).toBe(scratch.id);
  });

  it("without a target, the repository used last when it is still online and startable", () => {
    const all = [scratch, onlinePortal, billingRepo];
    expect(preselectedRepo(all, undefined, billingRepo.id)).toBe(billingRepo.id);
    // A target always wins over the last one used.
    expect(preselectedRepo(all, { teamProjectId: PORTAL_ID }, billingRepo.id)).toBe(onlinePortal.id);
    expect(preselectedRepo(all, onlinePortal.id, billingRepo.id)).toBe(onlinePortal.id);
    // Gone, offline or hidden since: the default rule.
    expect(preselectedRepo(all, undefined, "01a11635-d6e7-7c87-9f17-00000000dead")).toBe(scratch.id);
    expect(preselectedRepo([offlinePortal, scratch], undefined, offlinePortal.id)).toBe(scratch.id);
    expect(preselectedRepo([hidden, scratch], undefined, hidden.id)).toBe(scratch.id);
  });
});

/** Why Start session is unavailable, in the footer next to the button (never a silently disabled button). */
describe("startBlocker", () => {
  const project = {
    deviceName: "Ana's MacBook",
    deviceOnline: true,
    teamProjectHidden: false,
  };
  const base = {
    loading: false,
    hasProjects: true,
    project,
    runtimeLabel: "Claude Code",
    runtimeReady: true,
  };

  it("is null when everything is ready", () => {
    expect(startBlocker(base)).toBeNull();
  });

  it("names the first thing missing, in the order of the form", () => {
    expect(startBlocker({ ...base, loading: true, project: null })).toBe("Loading your projects…");
    expect(startBlocker({ ...base, hasProjects: false, project: null })).toBe(
      "Add a project to start a session",
    );
    expect(startBlocker({ ...base, project: null })).toBe("Choose a project");
    expect(startBlocker({ ...base, project: { ...project, teamProjectHidden: true } })).toBe(
      "Choose a project",
    );
    expect(startBlocker({ ...base, project: { ...project, deviceOnline: false } })).toBe(
      "Ana's MacBook is offline",
    );
    expect(startBlocker({ ...base, runtimeReady: false })).toBe("Claude Code isn't ready on Ana's MacBook");
  });
});

/** The one-line summary on the collapsed Model and permissions row. */
describe("settingsSummary", () => {
  it("says the defaults in words", () => {
    expect(
      settingsSummary({ modelLabel: null, effortLabel: null, modeLabel: "Supervised", worktree: false }),
    ).toBe("Default model · Supervised · Current checkout");
  });

  it("lists what was changed", () => {
    expect(
      settingsSummary({
        modelLabel: "Claude Sonnet 5.5",
        effortLabel: "High",
        modeLabel: "Auto-accept edits",
        worktree: true,
      }),
    ).toBe("Claude Sonnet 5.5 · High · Auto-accept edits · Isolated worktree");
  });
});

/** Arrow keys move between the options of a radio group (one tab stop per group). */
describe("stepRadio", () => {
  it("moves forward and back, wrapping", () => {
    expect(stepRadio(3, 0, "ArrowDown")).toBe(1);
    expect(stepRadio(3, 0, "ArrowRight")).toBe(1);
    expect(stepRadio(3, 2, "ArrowDown")).toBe(0);
    expect(stepRadio(3, 0, "ArrowUp")).toBe(2);
    expect(stepRadio(3, 1, "ArrowLeft")).toBe(0);
  });

  it("jumps to the ends, starts at the first when nothing has focus, ignores other keys", () => {
    expect(stepRadio(4, 2, "Home")).toBe(0);
    expect(stepRadio(4, 1, "End")).toBe(3);
    expect(stepRadio(4, -1, "ArrowDown")).toBe(0);
    expect(stepRadio(4, 1, "Enter")).toBeNull();
    expect(stepRadio(0, 0, "ArrowDown")).toBeNull();
  });
});

/** 07.11-10 (D-04, PD-13): a runtime card on the chosen device follows the manifest's verdict on its version. */
describe("runtimeCardState", () => {
  const info = { id: "claude-code" as const, installed: true, version: "2.1.200", loggedIn: true };
  const ask = "ask Owen to update";

  it("keeps a supported or unknown version ready with no note", () => {
    expect(runtimeCardState(info, "supported", ask)).toEqual({ ready: true, note: null, tone: "muted" });
    expect(runtimeCardState(info, undefined, ask)).toEqual({ ready: true, note: null, tone: "muted" });
    expect(runtimeCardState(info, "unknown", ask).ready).toBe(true);
  });

  it("keeps an unsupported version ready with a warning", () => {
    expect(runtimeCardState(info, "unsupported", ask)).toEqual({
      ready: true,
      note: "2.1.200 is older than supported · ask Owen to update",
      tone: "warning",
    });
  });

  it("disables a version that can't run sessions", () => {
    expect(runtimeCardState(info, "broken", ask)).toEqual({
      ready: false,
      note: "2.1.200 can't run sessions · ask Owen to update",
      tone: "destructive",
    });
  });

  it("still says why a runtime is missing or signed out first", () => {
    expect(runtimeCardState(undefined, "broken", ask).note).toBe("Not installed on this device");
    expect(runtimeCardState({ ...info, loggedIn: false }, "broken", ask).note).toBe(
      "Not signed in on this device",
    );
  });

  it("asks the owner, or points the owner to Settings › Devices", () => {
    expect(whoUpdates({ ownerUserId: LEO, ownerName: "Leo Park" }, PIA)).toBe("ask Leo Park to update");
    expect(whoUpdates({ ownerUserId: LEO, ownerName: null }, PIA)).toBe("ask its owner to update");
    expect(whoUpdates({ ownerUserId: LEO, ownerName: "Leo Park" }, LEO)).toBe(
      "update it in Settings › Devices",
    );
  });
});

describe("AddServerLink (07.12-07, owner feedback 2026-10-29)", () => {
  it("points from New session to Add a device › Server", () => {
    const html = renderToStaticMarkup(createElement(AddServerLink));
    expect(html).toContain('data-testid="new-session-add-server"');
    expect(html).toContain('href="/settings/devices?add=server"');
    expect(html).toContain("Run sessions on a server");
  });
});
