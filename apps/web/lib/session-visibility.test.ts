import type { WorkSession, WorkSessionVisibilitySummary } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import {
  announcement,
  chipName,
  choiceLines,
  firstName,
  footerAlwaysLine,
  footerCount,
  inactiveLine,
  longLabel,
  markerKind,
  markerSrSuffix,
  markerTooltip,
  narrowToast,
  plural,
  readOnlyNote,
  reasonLabel,
  sessionLabels,
  shortLabel,
} from "./session-visibility";

/**
 * The labels library (07.9-09, UI-SPEC Copywriting Contract, D-07, N4): every visibility word the UI shows comes from
 * here, pure. The browser never decides access: it only words what the API sent (`kind`, `activeCount`,
 * `differsFromDefault`).
 */

const summary = (over: Partial<WorkSessionVisibilitySummary> = {}): WorkSessionVisibilitySummary => ({
  kind: "project",
  activeCount: 0,
  differsFromDefault: false,
  firstTeamName: null,
  ...over,
});

const team = { projectName: "Customer portal", deviceName: "Ana's MacBook", personal: false };
const personal = { projectName: "scratch", deviceName: "Ana's MacBook", personal: true };
const mine = { ownerName: "Víctor Ruiz", viewerIsOwner: true };
const anas = { ownerName: "Ana Ruiz", viewerIsOwner: false };

describe("firstName and plural", () => {
  it("takes the display name's first word", () => {
    expect(firstName("Ana Ruiz")).toBe("Ana");
    expect(firstName("  Leo  ")).toBe("Leo");
    expect(firstName("")).toBe("");
  });

  it("uses the singular for exactly one", () => {
    expect(plural(1, "person", "people")).toBe("1 person");
    expect(plural(3, "person", "people")).toBe("3 people");
    expect(plural(0, "person", "people")).toBe("0 people");
    expect(plural(1, "repository", "repositories")).toBe("1 repository");
    expect(plural(2, "repository", "repositories")).toBe("2 repositories");
  });
});

describe("shortLabel (the chip, §1.3)", () => {
  const base = { activeCount: 0, firstTeamName: null };
  it("names the owner case from the viewer's side", () => {
    expect(shortLabel({ ...base, kind: "owner", ...mine })).toBe("Only me");
    expect(shortLabel({ ...base, kind: "owner", ...anas })).toBe("Only Ana");
    expect(shortLabel({ ...base, kind: "owner", ownerName: null, viewerIsOwner: false })).toBe(
      "Only the owner",
    );
  });

  it("says Project, a team name, a team count or a people count (owner counted)", () => {
    expect(shortLabel({ ...base, kind: "project", ...mine })).toBe("Project");
    expect(shortLabel({ kind: "teams", activeCount: 1, firstTeamName: "Web", ...mine })).toBe("Web");
    expect(shortLabel({ kind: "teams", activeCount: 2, firstTeamName: "Web", ...mine })).toBe("2 teams");
    expect(shortLabel({ kind: "people", activeCount: 2, firstTeamName: null, ...mine })).toBe("3 people");
  });

  it("reads teams or people with nobody active as the owner case (§1.5)", () => {
    expect(shortLabel({ kind: "teams", activeCount: 0, firstTeamName: null, ...mine })).toBe("Only me");
    expect(shortLabel({ kind: "people", activeCount: 0, firstTeamName: null, ...anas })).toBe("Only Ana");
  });
});

describe("longLabel (new-session line, tooltips, accessible names)", () => {
  it("names the owner in full", () => {
    expect(longLabel({ kind: "owner", activeCount: 0, ...mine, ...team })).toBe("Only you");
    expect(longLabel({ kind: "owner", activeCount: 0, ...anas, ...team })).toBe("Only Ana Ruiz");
  });

  it("names the project, or the device for a personal project", () => {
    expect(longLabel({ kind: "project", activeCount: 0, ...mine, ...team })).toBe(
      "Everyone in Customer portal",
    );
    expect(longLabel({ kind: "project", activeCount: 0, ...mine, ...personal })).toBe(
      "Everyone who can use Ana's MacBook",
    );
  });

  it("lists up to two teams by name, then says how many more", () => {
    expect(longLabel({ kind: "teams", activeCount: 1, teamNames: ["Web"], ...mine, ...team })).toBe("Web");
    expect(longLabel({ kind: "teams", activeCount: 2, teamNames: ["Web", "Design"], ...mine, ...team })).toBe(
      "Web and Design",
    );
    expect(
      longLabel({
        kind: "teams",
        activeCount: 4,
        teamNames: ["Web", "Design", "Backend", "QA"],
        ...mine,
        ...team,
      }),
    ).toBe("Web, Design and 2 more");
  });

  it("falls back to the first team or a count when the list row has no names", () => {
    expect(longLabel({ kind: "teams", activeCount: 1, firstTeamName: "Web", ...mine, ...team })).toBe("Web");
    expect(longLabel({ kind: "teams", activeCount: 3, firstTeamName: "Web", ...mine, ...team })).toBe(
      "3 teams",
    );
  });

  it("counts people with the owner, and reads nobody active as the owner case", () => {
    expect(longLabel({ kind: "people", activeCount: 2, ...mine, ...team })).toBe("3 people");
    expect(longLabel({ kind: "people", activeCount: 0, ...anas, ...team })).toBe("Only Ana Ruiz");
  });
});

describe("markerKind (Surface 2: silence on the default)", () => {
  it("shows nothing when the session follows its project's default, whatever the kind", () => {
    for (const kind of ["owner", "project", "teams", "people"] as const) {
      expect(markerKind(summary({ kind, activeCount: 1, differsFromDefault: false }))).toBe("none");
    }
    expect(markerKind(undefined)).toBe("none");
  });

  it("picks the icon only from what the server sent", () => {
    expect(markerKind(summary({ kind: "owner", differsFromDefault: true }))).toBe("lock");
    expect(markerKind(summary({ kind: "project", differsFromDefault: true }))).toBe("project");
    expect(markerKind(summary({ kind: "teams", activeCount: 2, differsFromDefault: true }))).toBe("users");
    expect(markerKind(summary({ kind: "people", activeCount: 1, differsFromDefault: true }))).toBe("users");
    expect(markerKind(summary({ kind: "people", activeCount: 0, differsFromDefault: true }))).toBe("lock");
  });
});

describe("marker tooltip and screen-reader suffix", () => {
  it("says who can see it", () => {
    expect(markerTooltip({ kind: "owner", activeCount: 0, ...mine, ...team })).toBe("Only visible to you");
    expect(markerTooltip({ kind: "owner", activeCount: 0, ...anas, ...team })).toBe(
      "Only visible to Ana Ruiz",
    );
    expect(markerTooltip({ kind: "project", activeCount: 0, ...mine, ...team })).toBe(
      "Visible to everyone in Customer portal",
    );
    expect(markerTooltip({ kind: "teams", activeCount: 1, firstTeamName: "Web", ...mine, ...team })).toBe(
      "Visible to Web",
    );
    expect(markerTooltip({ kind: "people", activeCount: 2, ...mine, ...team })).toBe("Visible to 3 people");
  });

  it("gives the row link the same meaning without the tooltip", () => {
    expect(markerSrSuffix({ kind: "owner", activeCount: 0, ...mine, ...team })).toBe(", only visible to you");
    expect(markerSrSuffix({ kind: "owner", activeCount: 0, ...anas, ...team })).toBe(
      ", only visible to Ana Ruiz",
    );
    expect(markerSrSuffix({ kind: "people", activeCount: 2, ...mine, ...team })).toBe(
      ", visible to 3 people",
    );
    expect(markerSrSuffix({ kind: "project", activeCount: 0, ...mine, ...team })).toBe(
      ", visible to everyone in Customer portal",
    );
  });
});

describe("sessionLabels (a list row's context)", () => {
  const session = (over: Partial<WorkSession>): WorkSession =>
    ({
      projectName: "web-app",
      deviceName: "Ana's MacBook",
      createdBy: "u-ana",
      createdByName: "Ana Ruiz",
      teamProject: { id: "p1", name: "Customer portal" },
      visibility: summary(),
      ...over,
    }) as WorkSession;

  it("words a row for its viewer, naming the team project when the repo is linked", () => {
    const s = session({ visibility: summary({ kind: "owner", differsFromDefault: true }) });
    expect(sessionLabels(s, "u-ana")).toMatchObject({
      marker: "lock",
      tooltip: "Only visible to you",
      srSuffix: ", only visible to you",
    });
    expect(sessionLabels(s, "u-leo")).toMatchObject({ marker: "lock", tooltip: "Only visible to Ana Ruiz" });
    const p = session({ visibility: summary({ kind: "project", differsFromDefault: true }) });
    expect(sessionLabels(p, "u-ana").tooltip).toBe("Visible to everyone in Customer portal");
    const unlinked = session({
      teamProject: null,
      visibility: summary({ kind: "project", differsFromDefault: true }),
    });
    expect(sessionLabels(unlinked, "u-ana").tooltip).toBe("Visible to everyone who can use Ana's MacBook");
  });

  it("is silent on the default and for replayed rows without a summary", () => {
    expect(sessionLabels(session({}), "u-ana")).toEqual({ marker: "none", tooltip: null, srSuffix: "" });
    expect(sessionLabels(session({ visibility: undefined }), "u-ana").marker).toBe("none");
  });
});

describe("footer (who can see it)", () => {
  it("counts people, or names the only one", () => {
    expect(footerCount(1, { ownerOnly: false, ...mine })).toBe("1 person can see this");
    expect(footerCount(12, { ownerOnly: false, ...mine })).toBe("12 people can see this");
    expect(footerCount(1, { ownerOnly: true, ...mine })).toBe("Only you can see this");
    expect(footerCount(1, { ownerOnly: true, ...anas })).toBe("Only Ana Ruiz can see this");
  });

  it("always names admins, and the device owner when someone else's device runs it (D-11)", () => {
    expect(footerAlwaysLine({ deviceOwner: null })).toBe("Admins can always see it.");
    expect(
      footerAlwaysLine({ deviceOwner: { firstName: "Ana", deviceName: "Ana's MacBook", isViewer: false } }),
    ).toBe("Admins and Ana can always see it: it runs on Ana's MacBook.");
    expect(
      footerAlwaysLine({ deviceOwner: { firstName: "Ana", deviceName: "Ana's MacBook", isViewer: true } }),
    ).toBe("Admins and you can always see it: it runs on Ana's MacBook.");
  });
});

describe("reasons, notes, toasts and announcements", () => {
  it("says why each person can see it", () => {
    expect(reasonLabel("owner")).toBe("Owner");
    expect(reasonLabel("owner_left", { project: "Customer portal" })).toBe("Owner · left Customer portal");
    expect(reasonLabel("device_owner")).toBe("Device owner");
    expect(reasonLabel("lead")).toBe("Lead");
    expect(reasonLabel("member")).toBe("Member");
    expect(reasonLabel("team", { via: "Web" })).toBe("Through Web");
    expect(reasonLabel("device", { via: "Ana's MacBook" })).toBe("Can use Ana's MacBook");
  });

  it("explains who can change it", () => {
    expect(readOnlyNote({ ownerName: "Ana Ruiz", leftProject: null })).toBe(
      "Only Ana Ruiz, project leads and admins can change this.",
    );
    expect(readOnlyNote({ ownerName: "Ana Ruiz", leftProject: "Customer portal" })).toBe(
      "You left Customer portal, so you can't change this.",
    );
  });

  it("says who lost access after narrowing", () => {
    expect(narrowToast(1, ["Leo"])).toBe("Leo can't see this session anymore.");
    expect(narrowToast(3, ["Leo", "Ana", "Sam"])).toBe("3 people can't see this session anymore.");
    expect(narrowToast(1, [])).toBe("1 person can't see this session anymore.");
  });

  it("announces the applied change", () => {
    expect(announcement("Everyone in Customer portal", 12)).toBe(
      "Visible to Everyone in Customer portal. 12 people can see it.",
    );
    expect(announcement("Only you", 1)).toBe("Visible to Only you. 1 person can see it.");
  });

  it("names the chip and the inactive entries", () => {
    expect(chipName("Only you", true)).toBe("Visible to Only you. Change who can see this session");
    expect(chipName("Web", false)).toBe("Visible to Web. See who can see this session");
    expect(inactiveLine("person", "Customer portal")).toBe("Left Customer portal");
    expect(inactiveLine("team", "Customer portal")).toBe("No longer assigned to Customer portal");
  });
});

describe("choiceLines (the four choices)", () => {
  it("words a team project", () => {
    const c = choiceLines({ ...team, ...mine, projectCount: 12, hasTeams: true });
    expect(c.owner).toEqual({ label: "Only me", line: "Just you." });
    expect(c.project).toEqual({ label: "Project", line: "Everyone in Customer portal · 12 people" });
    expect(c.teams).toEqual({ label: "Teams", line: "Choose from Customer portal's teams", disabled: false });
    expect(c.people).toEqual({ label: "People", line: "Choose people in Customer portal" });
  });

  it("disables Teams with the reason", () => {
    expect(choiceLines({ ...team, ...anas, projectCount: null, hasTeams: false }).teams).toEqual({
      label: "Teams",
      line: "Customer portal has no teams yet",
      disabled: true,
    });
    const p = choiceLines({ ...personal, ...anas, projectCount: 1, hasTeams: false });
    expect(p.owner).toEqual({ label: "Only Ana Ruiz", line: "Just Ana Ruiz." });
    expect(p.project.line).toBe("Everyone who can use Ana's MacBook · 1 person");
    expect(p.teams).toEqual({ label: "Teams", line: "Personal projects have no teams", disabled: true });
    expect(p.people.line).toBe("Choose people who can use Ana's MacBook");
  });
});

describe("plain words (N4)", () => {
  const banned = /\b(acl|grant|grants|granted|audience|scope|visibility rule)\b/i;

  it("no string the library produces says ACL, grant, audience, scope or visibility rule", () => {
    const kinds = ["owner", "project", "teams", "people"] as const;
    const outputs: string[] = [];
    for (const ctx of [team, personal])
      for (const who of [mine, anas])
        for (const kind of kinds)
          for (const activeCount of [0, 1, 2, 4]) {
            const s = {
              kind,
              activeCount,
              firstTeamName: "Web",
              teamNames: ["Web", "Design", "QA", "Ops"],
              ...who,
              ...ctx,
            };
            const label = longLabel(s);
            outputs.push(shortLabel(s), label, markerTooltip(s), markerSrSuffix(s), chipName(label, true));
            outputs.push(chipName(label, false), announcement(label, activeCount + 1));
            outputs.push(footerCount(activeCount + 1, { ownerOnly: activeCount === 0, ...who }));
            const c = choiceLines({ ...ctx, ...who, projectCount: activeCount, hasTeams: activeCount > 0 });
            outputs.push(...Object.values(c).flatMap((x) => [x.label, x.line]));
          }
    for (const r of ["owner", "owner_left", "device_owner", "lead", "member", "team", "device"] as const)
      outputs.push(reasonLabel(r, { via: "Web", project: "Customer portal" }));
    outputs.push(
      footerAlwaysLine({ deviceOwner: null }),
      footerAlwaysLine({ deviceOwner: { firstName: "Ana", deviceName: "Ana's MacBook", isViewer: false } }),
      readOnlyNote({ ownerName: "Ana Ruiz", leftProject: null }),
      readOnlyNote({ ownerName: "Ana Ruiz", leftProject: "Customer portal" }),
      narrowToast(1, ["Leo"]),
      narrowToast(4, []),
      inactiveLine("person", "Customer portal"),
      inactiveLine("team", "Customer portal"),
    );
    expect(outputs.length).toBeGreaterThan(300);
    for (const text of outputs) expect(text).not.toMatch(banned);
  });
});
