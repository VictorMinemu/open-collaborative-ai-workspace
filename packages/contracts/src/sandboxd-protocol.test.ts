import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  SANDBOX_LIMITS,
  SANDBOXD_ROUTES,
  SandboxdActResult,
  SandboxdContextAct,
  SandboxdContextInput,
  SandboxdContextNavigate,
  SandboxdContextOpen,
  SandboxdContextResize,
  SandboxdError,
  SandboxdExportStateResult,
  SandboxdPackageInstall,
  SandboxdPackageInstallResult,
  SandboxdPackageReviewResult,
  ScreenshotResult,
  SnapshotNode,
  SnapshotResult,
  StorageStateBlob,
} from "./index";

const ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ID2 = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const target = { orgId: ID, agentId: ID2 };
const SHA256 = "a".repeat(64);
const SHA512 = `sha512-${"A".repeat(86)}==`;

/** Every (path, schema) reachable from a schema, unwrapping optionals, defaults, arrays, unions and pipes. */
function walk(
  schema: z.ZodType,
  path: string,
  out: Array<{ path: string; schema: unknown }>,
  seen = new Set(),
) {
  if (seen.has(schema)) return;
  seen.add(schema);
  out.push({ path, schema });
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
  if (def.type === "object") {
    for (const [k, v] of Object.entries(def.shape as Record<string, z.ZodType>))
      walk(v, `${path}.${k}`, out, seen);
    return;
  }
  for (const key of ["innerType", "element", "in", "out", "left", "right", "valueType"]) {
    const child = def[key] as z.ZodType | undefined;
    if (child && typeof child === "object" && "_zod" in child) walk(child, path, out, seen);
  }
  for (const opt of (def.options as z.ZodType[] | undefined) ?? []) walk(opt, path, out, seen);
}

function reachable() {
  const out: Array<{ path: string; schema: unknown }> = [];
  for (const [op, route] of Object.entries(SANDBOXD_ROUTES)) {
    walk(route.input, `${op}.input`, out);
    walk(route.output, `${op}.output`, out);
  }
  return out;
}

describe("broker browser primitives (D-07, D-13, P-10, P-18, T-07.8-01-03)", () => {
  it("a bot op during a person's takeover is refused with the code `paused` (07.8-08; the brw agent's code)", () => {
    expect(
      SandboxdError.parse({ error: { code: "paused", message: "a person is in control" } }).error.code,
    ).toBe("paused");
  });

  it("a redacted snapshot node can only carry [redacted]", () => {
    const node = {
      ref: "e12",
      role: "textbox",
      name: "Password",
      value: "[redacted]",
      redacted: true,
      depth: 3,
    };
    expect(SnapshotNode.parse(node)).toEqual(node);
    expect(SnapshotNode.safeParse({ ...node, value: "S3cr3t-Hunter2" }).success).toBe(false);
    expect(SnapshotNode.safeParse({ ...node, value: null }).success).toBe(false);
    expect(SnapshotNode.safeParse({ ...node, value: "visible", redacted: false }).success).toBe(true);
    expect(SnapshotNode.safeParse({ ...node, name: "x".repeat(201) }).success).toBe(false);
    expect(
      SnapshotResult.safeParse({
        host: "example.com",
        title: "Sign in",
        nodes: Array(601).fill(node),
        text: "",
        truncated: true,
      }).success,
    ).toBe(false);
  });

  it("storage state travels only in context open and export state", () => {
    const paths = reachable()
      .filter((r) => r.schema === StorageStateBlob)
      .map((r) => r.path)
      .sort();
    expect(paths).toEqual(["contextExportState.output.storageState", "contextOpen.input.storageState"]);
    expect(StorageStateBlob.safeParse("x".repeat(2 * 1024 * 1024 + 1)).success).toBe(false);
    expect(StorageStateBlob.safeParse("not json").success).toBe(false);
    expect(
      SandboxdExportStateResult.parse({ storageState: '{"cookies":[],"origins":[]}' }).storageState,
    ).toContain("cookies");
  });

  it("no broker schema has a script, DOM, HTML or HAR key", () => {
    const banned = new Set(["script", "evaluate", "expression", "html", "dom", "har", "selector", "cookies"]);
    const hits = reachable()
      .map((r) => r.path.split(".").at(-1) ?? "")
      .filter((k) => banned.has(k.toLowerCase()));
    expect(hits).toEqual([]);
  });

  it("the site lock takes a host, never a URL; an approved navigation may pass it once", () => {
    const open = {
      target,
      contextId: ID,
      viewport: { width: 960, height: 600 },
      siteLock: "app.example.com",
    };
    expect(SandboxdContextOpen.parse(open).siteLock).toBe("app.example.com");
    expect(
      SandboxdContextOpen.safeParse({ ...open, siteLock: "https://app.example.com/login" }).success,
    ).toBe(false);
    expect(SandboxdContextOpen.safeParse({ ...open, memberId: ID, storageState: "{}" }).success).toBe(true);
    expect(SandboxdContextOpen.safeParse({ ...open, viewport: { width: 99_999, height: 600 } }).success).toBe(
      false,
    );
    expect(
      SandboxdContextNavigate.parse({
        target,
        contextId: ID,
        url: "https://evil.example/x",
        allowCrossSite: true,
      }).allowCrossSite,
    ).toBe(true);
    expect(
      SandboxdContextNavigate.safeParse({ target, contextId: ID, url: "javascript:alert(1)" }).success,
    ).toBe(false);
    expect(
      SandboxdContextNavigate.safeParse({ target, contextId: ID, url: "file:///etc/passwd" }).success,
    ).toBe(false);
    expect(
      SandboxdActResult.parse({
        navigated: false,
        blockedNavigation: { host: "evil.example" },
        download: null,
      }).blockedNavigation?.host,
    ).toBe("evil.example");
  });

  it("act takes a snapshot ref, never a selector or script", () => {
    const act = { target, contextId: ID, action: "type", ref: "e12", text: "hello" };
    expect(SandboxdContextAct.parse(act).ref).toBe("e12");
    expect(SandboxdContextAct.safeParse({ ...act, selector: "#password" }).success).toBe(false);
    expect(SandboxdContextAct.safeParse({ ...act, action: "evaluate" }).success).toBe(false);
    expect(SandboxdContextAct.safeParse({ ...act, ref: "e12; drop" }).success).toBe(false);
  });

  it("screenshots say how many fields were masked; input batches are bounded", () => {
    const shot = { mimeType: "image/jpeg", data: "AAAA", width: 960, height: 600, masked: 2 };
    expect(ScreenshotResult.parse(shot).masked).toBe(2);
    expect(ScreenshotResult.safeParse({ ...shot, mimeType: "image/svg+xml" }).success).toBe(false);
    expect(
      SandboxdContextInput.safeParse({ target, contextId: ID, events: [{ type: "text", text: "a" }] })
        .success,
    ).toBe(true);
    expect(SandboxdContextInput.safeParse({ target, contextId: ID, events: [] }).success).toBe(false);
  });

  it("input events are the live view's closed LiveInputFrame set, nothing looser (07.8-16)", () => {
    const ok = (events: unknown[]) =>
      SandboxdContextInput.safeParse({ target, contextId: ID, events }).success;
    expect(
      ok([
        { type: "key", event: "down", key: "a", code: "KeyA", modifiers: 0 },
        { type: "mouse", event: "down", x: 10, y: 20, button: "left" },
        { type: "wheel", x: 1, y: 1, dx: 0, dy: 120 },
        { type: "touch", event: "start", x: 5, y: 5 },
      ]),
    ).toBe(true);
    expect(ok([{ type: "script", source: "alert(1)" }])).toBe(false);
    expect(ok([{ type: "text", text: "a", selector: "#password" }])).toBe(false);
    expect(ok([{ type: "take" }])).toBe(false);
    expect(ok([{ type: "text", text: "x".repeat(1001) }])).toBe(false);
  });

  it("a resize may name the live view's mode (07.8-13); phone carries its size", () => {
    const base = { target, contextId: ID, width: 390, height: 700 };
    expect(SandboxdContextResize.parse({ ...base, mode: "phone" }).mode).toBe("phone");
    expect(SandboxdContextResize.parse(base).mode).toBeUndefined();
    expect(SandboxdContextResize.safeParse({ ...base, mode: "custom" }).success).toBe(false);
  });

  it("the route table uses the browser and package schemas", () => {
    expect(SANDBOXD_ROUTES.contextOpen.input).toBe(SandboxdContextOpen);
    expect(SANDBOXD_ROUTES.contextAct.output).toBe(SandboxdActResult);
    expect(SANDBOXD_ROUTES.contextSnapshot.output).toBe(SnapshotResult);
    expect(SANDBOXD_ROUTES.packageReview.output).toBe(SandboxdPackageReviewResult);
    expect(SANDBOXD_ROUTES.packageInstall.input).toBe(SandboxdPackageInstall);
    expect(SANDBOXD_ROUTES.contextFrames.stream).toBe(true);
  });
});

describe("broker package primitives (P-12, T-07.8-01-06)", () => {
  const entry = { name: "left-pad", version: "1.3.0", integrity: SHA512 };
  const review = {
    source: "npm",
    name: "left-pad",
    version: "1.3.0",
    sha256: SHA256,
    sizeBytes: 1024,
    license: "MIT",
    publisher: "someone",
    hasInstallScript: false,
    dependencyCount: 1,
    treeSha256: SHA256,
    entries: [entry],
    lockfile: "{}",
  };

  it("a review records the whole tree with its lockfile, bounded", () => {
    expect(SandboxdPackageReviewResult.parse(review).entries).toHaveLength(1);
    expect(
      SandboxdPackageReviewResult.safeParse({
        ...review,
        entries: Array(SANDBOX_LIMITS.packageTreeMaxEntries + 1).fill(entry),
      }).success,
    ).toBe(false);
    expect(
      SandboxdPackageReviewResult.safeParse({
        ...review,
        lockfile: "x".repeat(SANDBOX_LIMITS.packageLockfileMaxBytes + 1),
      }).success,
    ).toBe(false);
    expect(SandboxdPackageReviewResult.safeParse({ ...review, treeSha256: "A".repeat(64) }).success).toBe(
      false,
    );
    expect(
      SandboxdPackageReviewResult.safeParse({ ...review, entries: [{ ...entry, integrity: "sha1-abc" }] })
        .success,
    ).toBe(false);
    expect(
      SandboxdPackageReviewResult.safeParse({
        ...review,
        entries: [{ ...entry, integrity: `sha256:${SHA256}` }],
      }).success,
    ).toBe(true);
  });

  it("an install names the recorded tree; results say why a package failed", () => {
    const install = {
      target,
      packages: [
        {
          id: ID,
          source: "pypi",
          name: "requests",
          version: "2.32.3",
          sha256: SHA256,
          treeSha256: SHA256,
          lockfile: "x",
        },
      ],
    };
    expect(SandboxdPackageInstall.parse(install).packages).toHaveLength(1);
    expect(SandboxdPackageInstall.safeParse({ ...install, packages: [] }).success).toBe(false);
    const result = {
      results: [
        { id: ID, status: "failed", detail: "integrity mismatch", code: "tree_changed" },
        { id: ID2, status: "installed", detail: "" },
      ],
    };
    expect(SandboxdPackageInstallResult.parse(result).results[0]?.code).toBe("tree_changed");
    expect(
      SandboxdPackageInstallResult.safeParse({
        results: [{ id: ID, status: "failed", detail: "", code: "other" }],
      }).success,
    ).toBe(false);
  });
});
