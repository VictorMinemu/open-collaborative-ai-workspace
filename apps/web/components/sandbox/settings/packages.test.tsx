import type { SandboxPackage, SandboxPackageReview } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/lib/api";
import { draftError, reviewErrorMessage } from "./add-package-dialog";
import { dependencyLine, PackageFacts } from "./package-review-sheet";
import { PackageListView, packageStatus } from "./sandbox-packages";

/**
 * Sandbox packages as static markup (07.8-23; D-03, D-11, P-12, R12, UI-SPEC §4.4): the row statuses and their tones,
 * the changed-upstream hint and its Review… action, the read-only list, the empty box, the footnote, the review facts
 * (digest, dependency count, install script) and the Add dialog's messages. Rendered in node.
 */

const decode = (s: string) =>
  s
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

const SHA = "3f2a9c41d07be5a8c3e2f1d0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0";
const TREE = "a".repeat(64);

const pkg = (over: Partial<SandboxPackage> = {}): SandboxPackage => ({
  id: "11111111-1111-4111-8111-111111111111",
  source: "pypi",
  name: "pandas",
  version: "2.3.1",
  sha256: SHA,
  dependencyCount: 1,
  treeSha256: TREE,
  risk: "low",
  enabled: true,
  personalAllowed: false,
  installedIn: 0,
  installing: 0,
  failed: 0,
  changedUpstream: false,
  newerVersion: null,
  approvedBy: { id: "22222222-2222-4222-8222-222222222222", displayName: "Ana Pérez" },
  approvedAt: "2026-10-14T10:31:00.000Z",
  ...over,
});

const review = (over: Partial<SandboxPackageReview> = {}): SandboxPackageReview => ({
  source: "pypi",
  name: "pandas",
  version: "2.3.1",
  sha256: SHA,
  sizeBytes: 12_582_912,
  license: "BSD-3-Clause",
  publisher: "pandas-dev",
  hasInstallScript: false,
  dependencyCount: 1,
  treeSha256: TREE,
  risk: "medium",
  riskReasons: ["Runs an install script"],
  reviewToken: "spr1.x.y",
  ...over,
});

const noop = () => undefined;
const list = (items: SandboxPackage[], manage = true) =>
  decode(
    renderToStaticMarkup(
      <PackageListView
        items={items}
        manage={manage}
        pending={new Set()}
        onAdd={noop}
        onReview={noop}
        onRemove={noop}
        onToggle={noop}
      />,
    ),
  );

describe("packageStatus", () => {
  it("Installed counts its bots, singular for one", () => {
    expect(packageStatus(pkg({ installedIn: 1 }))).toMatchObject({
      key: "installed",
      label: "Installed in 1 bot",
      variant: "success",
      busy: false,
    });
    expect(packageStatus(pkg({ installedIn: 4 })).label).toBe("Installed in 4 bots");
  });

  it("Installing while installs are pending, and right after approval (each sandbox installs it at its next start)", () => {
    expect(packageStatus(pkg({ installing: 2, installedIn: 3 }))).toMatchObject({
      key: "installing",
      label: "Installing",
      variant: "warning",
      busy: true,
    });
    expect(packageStatus(pkg())).toMatchObject({ key: "installing", label: "Installing", busy: true });
  });

  it("Install failed, Removing (switched off while still installed) and Off", () => {
    expect(packageStatus(pkg({ failed: 1, installedIn: 2 }))).toMatchObject({
      key: "failed",
      label: "Install failed",
      variant: "destructive",
    });
    expect(packageStatus(pkg({ enabled: false, installedIn: 2 }))).toMatchObject({
      key: "removing",
      label: "Removing",
      variant: "outline",
      busy: true,
    });
    expect(packageStatus(pkg({ enabled: false }))).toMatchObject({ key: "off", label: "Off", busy: false });
  });

  it("Changed upstream wins over every count and asks for a new review", () => {
    expect(packageStatus(pkg({ changedUpstream: true, failed: 1, installedIn: 3 }))).toMatchObject({
      key: "changed",
      label: "Changed upstream",
      variant: "destructive",
      busy: false,
      hint: "A dependency changed after approval. Review it again.",
    });
  });
});

describe("PackageListView", () => {
  it("a row: tile, mono name and version, source, risk, status, the two switches and ⋯", () => {
    const html = list([pkg({ installedIn: 1 })]);
    expect(html).toContain('data-testid="package-row-11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('data-status="installed"');
    expect(html).toContain(">pandas<");
    expect(html).toContain(">2.3.1<");
    expect(html).toContain(">PyPI<");
    expect(html).toContain('data-testid="risk-low"');
    expect(html).toContain("Installed in 1 bot");
    expect(html).toContain("Bots can use it");
    expect(html).toContain("Off removes it from every sandbox");
    expect(html).toContain("Personal bots");
    expect(html).toContain("Members may use it in their own bot");
    expect(html).toContain('aria-label="pandas actions"');
    expect(html).toContain('data-testid="package-add"');
  });

  it("a changedUpstream row shows the hint and Review… as its action", () => {
    const html = list([pkg({ changedUpstream: true })]);
    expect(html).toContain('data-status="changed"');
    expect(html).toContain("Changed upstream");
    expect(html).toContain("A dependency changed after approval. Review it again.");
    expect(html).toContain('data-testid="package-review-again"');
    expect(html).toContain("Review…");
  });

  it("read-only: no Add, no switches, no ⋯, and who can approve", () => {
    const html = list([pkg({ installedIn: 2, changedUpstream: true })], false);
    expect(html).toContain("Only workspace admins can approve packages.");
    expect(html).not.toContain('data-testid="package-add"');
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain("actions");
    expect(html).not.toContain('data-testid="package-review-again"');
    expect(html).toContain("Changed upstream");
  });

  it("empty: the dashed box with Add package; the footnote", () => {
    const html = list([]);
    expect(html).toContain("No sandbox packages yet. Approve one so every bot's sandbox has it ready.");
    expect(html).toContain('data-testid="package-add"');
    expect(html).toContain(
      "Packages are installed only inside each bot's sandbox, never in the bot runtime. With Public network, bots can also install their own packages; set the sandbox shell to Allowlist to allow only approved ones.",
    );
  });

  it("every source has its label", () => {
    const html = list([
      pkg({ id: "a1111111-1111-4111-8111-111111111111", source: "npm", name: "left-pad" }),
      pkg({ id: "b1111111-1111-4111-8111-111111111111", source: "debian", name: "ffmpeg" }),
      pkg({ id: "c1111111-1111-4111-8111-111111111111", source: "clawhub", name: "pdf-tools" }),
    ]);
    expect(html).toContain(">npm<");
    expect(html).toContain(">Debian<");
    expect(html).toContain(">ClawHub skill<");
  });
});

describe("PackageFacts", () => {
  const facts = (over: Partial<SandboxPackageReview> = {}) =>
    decode(renderToStaticMarkup(<PackageFacts review={review(over)} />));

  it("the dependency count: none, one, many", () => {
    expect(dependencyLine(0)).toBe("No dependencies");
    expect(dependencyLine(1)).toBe("1 dependency, pinned by hash");
    expect(dependencyLine(12)).toBe("12 dependencies, each pinned by hash");
    expect(facts({ dependencyCount: 0 })).toContain("No dependencies");
    expect(facts({ dependencyCount: 1 })).toContain("1 dependency, pinned by hash");
    expect(facts({ dependencyCount: 3 })).toContain("3 dependencies, each pinned by hash");
  });

  it("digest (sha256: and 12 characters, copyable), license, publisher, size, source", () => {
    const html = facts();
    // 12 characters shown; the whole digest is what Copy digest copies (and the hover title).
    expect(html).toContain(`>sha256:${SHA.slice(0, 12)}<`);
    expect(html).toContain(`title="sha256:${SHA}"`);
    expect(html).toContain("Copy digest");
    expect(html).toContain("BSD-3-Clause");
    expect(html).toContain("pandas-dev");
    expect(html).toContain("12 MB");
    expect(html).toContain("PyPI");
  });

  it("the install-script fact, and missing license or publisher said plainly", () => {
    expect(facts({ hasInstallScript: true })).toContain("Runs an install script inside the sandbox");
    expect(facts({ hasInstallScript: false })).toContain("No install script");
    const html = facts({ license: null, publisher: null });
    expect(html).toContain("Not declared");
    expect(html).toContain("Unknown");
  });

  it("registry text is plain text, never markup", () => {
    const html = renderToStaticMarkup(
      <PackageFacts review={review({ publisher: "<img src=x onerror=1>" })} />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("Add package", () => {
  it("asks for a name and one exact version", () => {
    expect(draftError({ source: "npm", name: " ", version: "1.0.0" })).toEqual({
      field: "name",
      message: "Enter a package name",
    });
    expect(draftError({ source: "npm", name: "left pad", version: "1.0.0" })?.field).toBe("name");
    expect(draftError({ source: "npm", name: "left-pad", version: "" })).toEqual({
      field: "version",
      message: "Enter the exact version, like 2.3.1",
    });
    expect(draftError({ source: "npm", name: "left-pad", version: "^1.3" })?.field).toBe("version");
    expect(draftError({ source: "npm", name: "@scope/left-pad", version: "1.3.0" })).toBeNull();
  });

  it("names the source when the registry has no such package or can't be reached", () => {
    const missing = new ApiRequestError(404, "package_not_found", "x");
    expect(reviewErrorMessage(missing, { source: "pypi", name: "pandsa", version: "1" })).toBe(
      "No package called “pandsa” on PyPI.",
    );
    const down = new ApiRequestError(503, "service_unavailable", "x");
    expect(reviewErrorMessage(down, { source: "npm", name: "a", version: "1" })).toBe(
      "Couldn't reach npm. Try again.",
    );
    const other = new ApiRequestError(400, "some_new_code", "Something specific");
    expect(reviewErrorMessage(other, { source: "npm", name: "a", version: "1" })).toBe("Something specific");
  });
});
