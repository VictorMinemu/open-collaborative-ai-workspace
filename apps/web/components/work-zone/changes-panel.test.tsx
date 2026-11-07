import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NoGitState, projectHasNoGit } from "./changes-panel";

const at = "2026-11-06T00:00:00.000Z";

describe("changes panel: a project without git", () => {
  it("is decided by the device's diff (or the last live changes), never guessed from a null branch", () => {
    expect(projectHasNoGit(undefined, null)).toBe(false);
    expect(
      projectHasNoGit(
        { files: [], patch: "", truncated: false, branch: null, headSha: null, generatedAt: at },
        null,
      ),
    ).toBe(false);
    expect(
      projectHasNoGit(
        { files: [], patch: "", truncated: false, branch: null, headSha: null, generatedAt: at, git: false },
        null,
      ),
    ).toBe(true);
    expect(
      projectHasNoGit(undefined, {
        files: [],
        branch: null,
        headSha: null,
        truncated: false,
        at,
        git: false,
      }),
    ).toBe(true);
  });

  it("renders a clear No git state instead of an error or an empty diff", () => {
    const html = renderToStaticMarkup(<NoGitState />);
    expect(html).toContain('data-testid="changes-no-git"');
    expect(html).toContain("No git");
    expect(html).toContain("not tracked");
  });
});
