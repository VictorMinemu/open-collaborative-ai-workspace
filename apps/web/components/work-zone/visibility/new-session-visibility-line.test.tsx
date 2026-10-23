import type { Project } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { lineModel, NewSessionVisibilityLine } from "./new-session-visibility-line";
import { modelFromDraft, PanelBody } from "./visibility-panel";

/**
 * The new-session line (07.9-14, UI-SPEC Surface 3, D-03, D-07): "Visible to: {long label} · Change", one row, under
 * the Project section; Change opens the panel in draft mode. Static markup from fixture repositories.
 */

const UNIT = "01a11635-d6e7-7c87-9f17-0000000000e1";
const WEB = "01a11635-d6e7-7c87-9f17-0000000000d1";
const DESIGN = "01a11635-d6e7-7c87-9f17-0000000000d2";
const ANA = "01a11635-d6e7-7c87-9f17-0000000000a1";
const LEO = "01a11635-d6e7-7c87-9f17-0000000000a2";

function repo(over: Partial<Project> = {}): Project {
  return {
    id: "01a11635-d6e7-7c87-9f17-000000000001",
    deviceId: "01a11635-d6e7-7c87-9f17-00000000a0a1",
    deviceName: "Ana's MacBook",
    deviceOnline: true,
    name: "web-app",
    gitRemote: null,
    defaultBranch: "main",
    available: true,
    createdAt: "2026-10-23T08:00:00.000Z",
    ...over,
  };
}
const teamRepo = (defaultVisibility: "project" | "owner" = "project") =>
  repo({ teamProject: { id: UNIT, name: "Customer portal", defaultVisibility } });

const noop = () => undefined;
const render = (project: Project | null, value: Parameters<typeof NewSessionVisibilityLine>[0]["value"]) =>
  renderToStaticMarkup(<NewSessionVisibilityLine project={project} value={value} onChange={noop} />);

/** The visible text of a fragment of markup (tags dropped, entities decoded). */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&");

describe("NewSessionVisibilityLine", () => {
  it("reads 'Visible to: {long label} · Change' with the Change button's accessible name", () => {
    const html = render(teamRepo(), { kind: "project" });
    expect(html).toContain('data-testid="new-session-visibility"');
    expect(html).toContain('data-kind="project"');
    expect(text(html)).toBe("Visible to: Everyone in Customer portal · Change");
    expect(html).toMatch(
      /<button[^>]*aria-label="Change who can see this session"[^>]*data-testid="new-session-visibility-change"|<button[^>]*data-testid="new-session-visibility-change"[^>]*aria-label="Change who can see this session"/,
    );
    // Never a submit: it sits inside the dialog's form.
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Change<\/button>/);
    // The long label truncates in its row with the full text in its title (UI-SPEC "Names truncate").
    expect(html).toContain('title="Everyone in Customer portal"');
  });

  it("words each audience as the long label: Only you, the device, teams, people", () => {
    expect(text(render(teamRepo("owner"), { kind: "owner" }))).toContain("Only you");
    expect(text(render(repo(), { kind: "project" }))).toContain("Everyone who can use Ana's MacBook");
    expect(
      text(
        render(teamRepo(), {
          kind: "teams",
          teams: [
            { id: WEB, name: "Web" },
            { id: DESIGN, name: "Design" },
          ],
        }),
      ),
    ).toContain("Web and Design");
    expect(
      text(
        render(teamRepo(), { kind: "people", people: [{ userId: LEO, name: "Leo Park", avatarUrl: null }] }),
      ),
    ).toContain("2 people");
  });

  it("renders nothing without a project, without an audience, or on a repository nobody can start on here", () => {
    expect(render(null, { kind: "project" })).toBe("");
    expect(render(teamRepo(), null)).toBe("");
    expect(render(repo({ teamProjectHidden: true }), { kind: "project" })).toBe("");
  });

  it("describes where the draft runs: the team project, or the device of a personal repository", () => {
    expect(lineModel(teamRepo("owner"), { kind: "owner" })?.place).toEqual({
      kind: "team",
      unitId: UNIT,
      name: "Customer portal",
      defaultVisibility: "owner",
    });
    expect(lineModel(repo(), { kind: "project" })?.place).toEqual({
      kind: "personal",
      deviceName: "Ana's MacBook",
    });
  });
});

describe("draft footer", () => {
  it("a failed preview shows '—' instead of a count; the choice itself is untouched", () => {
    const model = modelFromDraft({
      value: { kind: "project" },
      place: { kind: "team", unitId: UNIT, name: "Customer portal", defaultVisibility: "project" },
      teams: [],
      preview: undefined,
      previewFailed: true,
      viewer: { userId: ANA, name: "Ana Ruiz" },
    });
    const html = renderToStaticMarkup(
      <PanelBody
        model={model}
        surface="inline"
        apply={() => Promise.resolve(true)}
        search={{ q: "", onQuery: noop, results: undefined, searching: false }}
        announce=""
      />,
    );
    expect(html).toContain('data-count=""');
    expect(html).toContain("—");
    expect(html).toMatch(
      /<input[^>]*type="radio"[^>]*value="project"[^>]*checked|checked[^>]*value="project"/,
    );
  });
});
