import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LinkableRepos, WorkProjectDetail, WorkSession } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { removeFromProjectSentence } from "@/components/organization/unit-detail";
import { ASSIGN_COPY, AssignableList } from "./assign-teams-dialog";
import { LINK_COPY, LinkableList, linkBlock } from "./link-repo-dialog";
import { ProjectAccessLine } from "./project-access-line";
import { DEFAULT_SWITCH_COPY, ProjectDefaultSwitchRow } from "./project-default-switch";
import { accessTitle, peopleCount, teamRowCaption } from "./project-labels";
import { ProjectReposBody, REPOS_COPY, unlinkConsequence } from "./project-repos-section";
import { ProjectSessionsBody, SESSIONS_COPY } from "./project-sessions";
import { ProjectSettingsLayout, readOnlySettings, SETTINGS_COPY } from "./project-settings";
import { ProjectTeamsBody, TEAMS_COPY } from "./project-teams-section";
import { ListError } from "./settings-list";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => (
    <a href={href} {...(rest as object)}>
      {children as never}
    </a>
  ),
}));

/**
 * The project Settings tab and its dialogs (07.9-13, UI-SPEC § 4.3, § 4.4, D-03, D-10, D-14, U-6, U-7, U-8): every
 * section editable and read-only, the zero-one-many copy, the list states, and no host path anywhere. The API decides
 * `viewerCan`; these components only render it.
 */

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
const noop = () => undefined;

const PORTAL = "01a11635-d6e7-7c87-9f17-0000000000d1";
const PARENT = "01a11635-d6e7-7c87-9f17-0000000000d2";
const OTHER = "01a11635-d6e7-7c87-9f17-0000000000d3";
const WEB = "01a11635-d6e7-7c87-9f17-0000000000e1";
const DESIGN = "01a11635-d6e7-7c87-9f17-0000000000e2";
const REPO = "01a11635-d6e7-7c87-9f17-0000000000b1";
const REPO2 = "01a11635-d6e7-7c87-9f17-0000000000b2";
const DEVICE = "01a11635-d6e7-7c87-9f17-0000000000c1";

const EDITOR = { manage: true, assignTeams: true, members: true, open: true };
const READER = { manage: false, assignTeams: false, members: false, open: true };

const detail = (over: Partial<WorkProjectDetail> = {}): WorkProjectDetail => ({
  id: PORTAL,
  name: "Customer portal",
  parentId: PARENT,
  trail: ["Engineering", "Web"],
  defaultVisibility: "project",
  access: {
    count: 14,
    people: [1, 2, 3, 4, 5].map((i) => ({
      userId: `01a11635-d6e7-7c87-9f17-00000000001${i}`,
      name: `Person ${i}`,
      avatarUrl: null,
    })),
  },
  teams: [
    { id: WEB, name: "Web", kind: "team", memberCount: 8 },
    { id: DESIGN, name: "Design", kind: "department", memberCount: 1 },
  ],
  repos: [
    {
      projectId: REPO,
      name: "web-app",
      deviceId: DEVICE,
      deviceName: "Ana's MacBook",
      deviceOnline: true,
      branch: "main",
      available: true,
    },
  ],
  viewerCan: EDITOR,
  ...over,
});

const ACTIONS = ["assign-teams", "remove-team", "link-repo", "unlink-repo"];

function sections(p: WorkProjectDetail) {
  return [
    html(<ProjectTeamsBody project={p} onAssign={noop} onRemove={noop} />),
    html(<ProjectReposBody project={p} onLink={noop} onUnlink={noop} />),
  ].join("");
}

describe("the Settings tab sections (UI-SPEC § 4.3)", () => {
  it("an editor gets every action; a read-only viewer gets none of them and the one line saying who changes them", () => {
    const editor = sections(detail());
    for (const id of ACTIONS) expect(editor).toContain(`data-testid="${id}"`);

    const reader = detail({ viewerCan: READER });
    const markup = sections(reader);
    for (const id of ACTIONS) expect(markup).not.toContain(`data-testid="${id}"`);
    expect(readOnlySettings(reader)).toBe(true);
    const layout = html(
      <ProjectSettingsLayout project={reader} defaultSwitch={null} people={null} teams={null} repos={null} />,
    );
    expect(text(layout)).toContain(SETTINGS_COPY.readOnly);
    expect(SETTINGS_COPY.readOnly).toBe("Only project leads and admins change these settings.");
    // A project lead may not assign teams (that is the parent's) but changes the rest: not read-only.
    expect(readOnlySettings(detail({ viewerCan: { ...EDITOR, assignTeams: false } }))).toBe(false);
    expect(
      text(
        html(
          <ProjectSettingsLayout
            project={detail()}
            defaultSwitch={null}
            people={null}
            teams={null}
            repos={null}
          />,
        ),
      ),
    ).not.toContain(SETTINGS_COPY.readOnly);
  });

  it("orders Access, New sessions, People, Teams, Repositories", () => {
    const markup = html(
      <ProjectSettingsLayout
        project={detail()}
        defaultSwitch={<i>SWITCH</i>}
        people={<i>PEOPLE</i>}
        teams={<i>TEAMS</i>}
        repos={<i>REPOS</i>}
      />,
    );
    const at = (s: string) => markup.indexOf(s);
    expect(at('data-testid="project-access"')).toBeGreaterThan(-1);
    const order = ['data-testid="project-access"', "New sessions", "SWITCH", "PEOPLE", "TEAMS", "REPOS"].map(
      at,
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("the access line: the API's count, five faces at most, singular for one", () => {
    const markup = html(<ProjectAccessLine project={detail()} />);
    expect(text(markup)).toContain("14 people can open this project");
    expect(text(markup)).toContain("Its members, people in its teams, and admins.");
    expect(accessTitle(1)).toBe("1 person can open this project");
    expect(accessTitle(0)).toBe("Only admins can open this project");
  });

  it("the default switch: its sentence, on for the default, disabled with its state for a read-only viewer", () => {
    const editable = html(<ProjectDefaultSwitchRow project={detail()} onChange={noop} />);
    expect(text(editable)).toContain("Visible to everyone in the project");
    expect(text(editable)).toContain(
      "When off, new sessions start as Only me. Existing sessions don't change.",
    );
    expect(editable).toContain(`aria-label="${DEFAULT_SWITCH_COPY.ariaLabel}"`);
    expect(editable).toContain('aria-checked="true"');
    expect(editable).not.toMatch(/ data-disabled=""| aria-disabled="true"/);

    const off = html(
      <ProjectDefaultSwitchRow
        project={detail({ defaultVisibility: "owner", viewerCan: READER })}
        onChange={noop}
      />,
    );
    expect(off).toContain('aria-checked="false"');
    expect(off).toMatch(/ data-disabled=""| aria-disabled="true"/);
    expect(DEFAULT_SWITCH_COPY.off("Customer portal")).toBe(
      "New sessions in Customer portal start as Only me",
    );
    expect(DEFAULT_SWITCH_COPY.on("Customer portal")).toBe(
      "New sessions in Customer portal start visible to everyone",
    );
  });

  it("team rows read '{Kind} · {n} people' (singular for one) and truncate with the full name in title", () => {
    const markup = html(<ProjectTeamsBody project={detail()} onAssign={noop} onRemove={noop} />);
    expect(text(markup)).toContain("Team · 8 people");
    expect(text(markup)).toContain("Department · 1 person");
    expect(markup).toContain(`data-testid="project-team-row-${WEB}"`);
    expect(markup).toContain('title="Web"');
    expect(markup).toContain('aria-label="Remove Web from Customer portal"');
    expect(text(markup)).toContain("Everyone in these teams can open Customer portal and its sessions.");
    expect(teamRowCaption({ kind: "team", memberCount: 0 })).toBe("Team · 0 people");
    expect(peopleCount(1)).toBe("1 person");
  });

  it("empty lists say what to do (editors) or only the fact (others)", () => {
    const empty = detail({ teams: [], repos: [] });
    const markup = text(sections(empty));
    expect(markup).toContain(
      "No teams assigned. Assign one so its people join without being added one by one.",
    );
    expect(markup).toContain("No repositories linked. Link one from a device you can use.");
    const other = text(sections({ ...empty, viewerCan: READER }));
    expect(other).toContain(TEAMS_COPY.emptyOther);
    expect(other).toContain(REPOS_COPY.emptyOther);
    expect(other).not.toContain("Assign one");
  });

  it("repository rows read '{device} ● Online · ⑂ {branch}' with the branch in mono, and never a path", () => {
    const withPath = detail({
      repos: [
        // A path the API never sends (principle 7); were it present, nothing renders it.
        { ...detail().repos[0], localPath: "/Users/ana/src/web-app" } as WorkProjectDetail["repos"][number],
        {
          projectId: REPO2,
          name: "api",
          deviceId: DEVICE,
          deviceName: "Luis's PC",
          deviceOnline: false,
          branch: null,
          available: false,
        },
      ],
    });
    const markup = html(<ProjectReposBody project={withPath} onLink={noop} onUnlink={noop} />);
    const words = text(markup);
    expect(words).toContain("Ana's MacBook Online · branch main");
    expect(markup).toMatch(/class="[^"]*font-mono[^"]*"[^>]*>main</);
    expect(words).toContain(`Luis's PC Offline · ${REPOS_COPY.unavailable}`);
    expect(markup).not.toContain("/Users/");
    expect(markup).toContain('aria-label="Unlink web-app"');
    expect(markup).toContain(`data-testid="project-repo-row-${REPO}"`);
  });

  it("a list error is an inline alert row with Try again", () => {
    const markup = html(<ListError message="Couldn't load teams." onRetry={noop} />);
    expect(markup).toContain('role="alert"');
    expect(text(markup)).toContain("Couldn't load teams. Try again");
    const assign = html(
      <AssignableList
        teams={undefined}
        loading={false}
        error
        onRetry={noop}
        query=""
        pendingId={null}
        onAssign={noop}
      />,
    );
    expect(assign).toContain('role="alert"');
    const link = html(
      <LinkableList
        projectId={PORTAL}
        devices={undefined}
        loading={false}
        error
        onRetry={noop}
        pendingId={null}
        onLink={noop}
      />,
    );
    expect(link).toContain('role="alert"');
    expect(text(link)).toContain(LINK_COPY.error);
  });
});

describe("the dialogs (UI-SPEC § 4.4)", () => {
  it("remove team names who loses access; unlink states the server's count (zero-one-many)", () => {
    expect(TEAMS_COPY.removeTitle("Web", "Customer portal")).toBe("Remove Web from Customer portal?");
    expect(TEAMS_COPY.removeBody("Web", "Customer portal")).toBe(
      "People who are in Customer portal only through Web lose access now, including sessions shared with Web.",
    );
    expect(TEAMS_COPY.removeConfirm).toBe("Remove team");
    expect(unlinkConsequence(3, "Ana's MacBook")).toBe(
      "3 sessions on it become personal: only people who can use Ana's MacBook will see them.",
    );
    expect(unlinkConsequence(1, "Ana's MacBook")).toBe(
      "1 session on it becomes personal: only people who can use Ana's MacBook will see it.",
    );
    expect(unlinkConsequence(0, "Ana's MacBook")).toBe("It has no sessions.");
  });

  it("assign: units with their counts, 'No team matches' for a miss, 'Every team is already assigned' otherwise", () => {
    const teams = detail().teams;
    const rows = html(
      <AssignableList
        teams={teams}
        loading={false}
        error={false}
        onRetry={noop}
        query=""
        pendingId={null}
        onAssign={noop}
      />,
    );
    expect(rows).toContain(`data-testid="assign-team-option-${WEB}"`);
    expect(rows).toContain('aria-label="Assign Web, Team · 8 people"');
    const miss = text(
      html(
        <AssignableList
          teams={[]}
          loading={false}
          error={false}
          onRetry={noop}
          query="zz"
          pendingId={null}
          onAssign={noop}
        />,
      ),
    );
    expect(miss).toContain("No team matches “zz”");
    const all = text(
      html(
        <AssignableList
          teams={[]}
          loading={false}
          error={false}
          onRetry={noop}
          query=""
          pendingId={null}
          onAssign={noop}
        />,
      ),
    );
    expect(all).toBe(ASSIGN_COPY.allAssigned);
  });

  it("link: grouped by device, names only; a repository in another project is shown where it is and disabled", () => {
    const devices: LinkableRepos["devices"] = [
      {
        deviceId: DEVICE,
        deviceName: "Ana's MacBook",
        deviceOnline: true,
        repos: [
          { projectId: REPO, name: "web-app", linkedTo: null },
          { projectId: REPO2, name: "billing-api", linkedTo: { id: OTHER, name: "Billing" } },
          { projectId: DESIGN, name: "secret", linkedTo: null, linkedToHidden: true },
          { projectId: WEB, name: "portal-ui", linkedTo: { id: PORTAL, name: "Customer portal" } },
        ],
      },
    ];
    const markup = html(
      <LinkableList
        projectId={PORTAL}
        devices={devices}
        loading={false}
        error={false}
        onRetry={noop}
        pendingId={null}
        onLink={noop}
      />,
    );
    const words = text(markup);
    expect(words).toContain("Ana's MacBook Online");
    expect(words).toContain("In Billing");
    expect(words).toContain("In another project");
    expect(words).toContain("Already linked");
    const option = (id: string) =>
      markup.match(new RegExp(`<button[^>]*data-testid="link-repo-option-${id}"[^>]*>`))?.[0] ?? "";
    expect(option(REPO)).not.toContain(' disabled=""');
    expect(option(REPO2)).toContain(' disabled=""');
    expect(option(DESIGN)).toContain(' disabled=""');
    expect(linkBlock(devices[0]?.repos[0] as never, PORTAL)).toBeNull();
    expect(
      text(
        html(
          <LinkableList
            projectId={PORTAL}
            devices={[]}
            loading={false}
            error={false}
            onRetry={noop}
            pendingId={null}
            onLink={noop}
          />,
        ),
      ),
    ).toBe(LINK_COPY.none);
  });

  it("the link dialog's source never reads a host path (principle 7)", () => {
    const src = readFileSync(join(__dirname, "link-repo-dialog.tsx"), "utf8");
    expect(src).not.toMatch(/localPath|absolutePath|hostPath/);
  });
});

describe("the remove-member dialog and the manager outside the project (R9, D-14)", () => {
  it("removing someone from a project also says they stop seeing its sessions", () => {
    expect(removeFromProjectSentence("Customer portal")).toBe(
      "They also stop seeing Customer portal's sessions unless a team still gives them access.",
    );
  });

  it("a manager outside the project reads why no session shows, with a way to Settings when they may add people", () => {
    const outside = detail({ viewerCan: { ...EDITOR, open: false } });
    const props = {
      sessions: [] as WorkSession[],
      viewerId: null,
      target: { kind: "absent" as const },
      onStart: noop,
    };
    const join = text(html(<ProjectSessionsBody project={outside} {...props} onOpenSettings={noop} />));
    expect(join).toContain(SESSIONS_COPY.managerOutsideJoin);
    expect(join).toContain("Open Settings");
    const only = text(
      html(
        <ProjectSessionsBody
          project={detail({ viewerCan: { ...EDITOR, members: false, open: false } })}
          {...props}
          onOpenSettings={noop}
        />,
      ),
    );
    expect(only).toContain(SESSIONS_COPY.managerOutside);
    expect(only).not.toContain("Open Settings");
    // People in the project keep the plain empty state.
    expect(text(html(<ProjectSessionsBody project={detail()} {...props} />))).toContain(
      SESSIONS_COPY.noSessionsBody,
    );
  });
});
