import { describe, expect, it } from "vitest";
import {
  ActivityStep,
  ActivityVerb,
  AgentChannelSandboxDelete,
  AgentChannelSandboxExec,
  AgentChannelSandboxExecResponse,
  AgentChannelSandboxImport,
  AgentChannelSandboxList,
  AgentChannelSandboxProcess,
  AgentChannelSandboxRead,
  AgentChannelSandboxShare,
  AgentChannelSandboxWrite,
  AllowHost,
  ApproveSandboxPackageRequest,
  BotTurnActivity,
  DEFAULT_SANDBOX_SETTINGS,
  decodeFrameHeader,
  encodeFrame,
  FRAME_HEADER_BYTES,
  FRAME_MAX_PAYLOAD_BYTES,
  FRAME_TYPES,
  Message,
  PackageTreeEntry,
  packageTreeCanonical,
  ReviewSandboxPackageRequest,
  SANDBOX_LIMITS,
  SANDBOX_REFUSAL_STATUS,
  SANDBOXD_LABELS,
  SANDBOXD_ROUTES,
  SandboxdError,
  SandboxdErrorCode,
  SandboxdEventsResponse,
  SandboxdExec,
  SandboxdExecResult,
  SandboxdOrgPolicy,
  SandboxFileList,
  SandboxFilePath,
  SandboxFilePreview,
  SandboxIsolationInfo,
  SandboxPackage,
  SandboxPackageList,
  SandboxPackageReview,
  SandboxRefusal,
  SandboxRelativePath,
  SandboxSettings,
  SandboxSettingsView,
  SandboxStatusView,
  TurnActivityEvent,
  UpdateSandboxPackageRequest,
  UpdateSandboxSettingsRequest,
} from "./index";

const ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ID2 = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const NOW = "2026-10-15T10:00:00.000Z";

describe("sandbox relative paths (T-07.8-01-02)", () => {
  it.each(["", "a/b.txt", "reports/q3.csv", ".hidden", "a/.env.example", "x..y"])("accepts %j", (p) => {
    expect(SandboxRelativePath.safeParse(p).success).toBe(true);
  });

  it.each(["/a", "a/../b", "..", "./a", "a/.", "a\\b", "a\u0000b", "a//b", "a/", "x".repeat(1025)])(
    "refuses %j",
    (p) => {
      expect(SandboxRelativePath.safeParse(p).success).toBe(false);
    },
  );

  it("a file path is a non-empty relative path (the root is never a file)", () => {
    expect(SandboxFilePath.safeParse("").success).toBe(false);
    expect(SandboxFilePath.safeParse("a.txt").success).toBe(true);
    expect(SandboxRelativePath.safeParse("x".repeat(SANDBOX_LIMITS.pathMaxChars)).success).toBe(true);
  });
});

describe("Agent Channel sandbox exec (D-02, T-07.8-01-01)", () => {
  const body = { eventId: ID, agentId: ID2, argv: ["sh", "-c", "echo hi"] };

  it("parses an argv array with the optional cwd, timeout and background", () => {
    expect(AgentChannelSandboxExec.parse(body)).toEqual(body);
    const full = { ...body, cwd: "reports", timeoutSeconds: 600, background: true };
    expect(AgentChannelSandboxExec.parse(full)).toEqual(full);
  });

  it("refuses a shell string, an unbounded argv, an oversized argument, a long timeout, bad cwds and unknown keys", () => {
    const bad: unknown[] = [
      { eventId: ID, agentId: ID2, command: "echo hi" },
      { ...body, command: "echo hi" },
      { ...body, argv: "echo hi" },
      { ...body, argv: [] },
      { ...body, argv: Array(65).fill("x") },
      { ...body, argv: ["echo", "x".repeat(8193)] },
      { ...body, argv: [""] },
      { ...body, timeoutSeconds: 601 },
      { ...body, timeoutSeconds: 0 },
      { ...body, cwd: "/etc" },
      { ...body, cwd: "../x" },
      { ...body, userId: ID },
    ];
    for (const b of bad)
      expect(AgentChannelSandboxExec.safeParse(b).success, JSON.stringify(b).slice(0, 80)).toBe(false);
    expect(AgentChannelSandboxExec.safeParse({ ...body, argv: Array(64).fill("x") }).success).toBe(true);
    expect(AgentChannelSandboxExec.safeParse({ ...body, argv: ["echo", "x".repeat(8192)] }).success).toBe(
      true,
    );
  });

  it("one exec flows agent body → sandboxd op → result → tool response", () => {
    const agent = AgentChannelSandboxExec.parse({ ...body, cwd: "reports", timeoutSeconds: 30 });
    const op = SandboxdExec.parse({
      target: { orgId: ID, agentId: agent.agentId },
      argv: agent.argv,
      cwd: agent.cwd ?? "",
      timeoutMs: (agent.timeoutSeconds ?? 60) * 1000,
      yieldMs: SANDBOX_LIMITS.execYieldMs,
    });
    expect(SandboxdExec.parse(JSON.parse(JSON.stringify(op)))).toEqual(op);
    expect(SandboxdExec.safeParse({ ...op, env: { PATH: "/x" } }).success).toBe(false);
    expect(SandboxdExec.safeParse({ ...op, timeoutMs: 600_001 }).success).toBe(false);

    const exited = {
      status: "exited",
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
      truncated: false,
      durationMs: 12,
    };
    const running = {
      status: "running",
      processId: "p_01",
      stdout: "",
      stderr: "",
      truncated: false,
      durationMs: 25_000,
    };
    for (const r of [exited, running]) {
      expect(SandboxdExecResult.parse(r)).toEqual(r);
      expect(AgentChannelSandboxExecResponse.parse(SandboxdExecResult.parse(r))).toEqual(r);
    }
    expect(SandboxdExecResult.safeParse({ ...exited, stdout: "x".repeat(16_385) }).success).toBe(false);
    expect(SandboxdExecResult.safeParse({ ...running, processId: "../p" }).success).toBe(false);
  });

  it("every refusal has an HTTP status", () => {
    for (const code of SandboxRefusal.options) {
      expect([403, 404, 409, 413, 422, 503]).toContain(SANDBOX_REFUSAL_STATUS[code]);
    }
    expect(Object.keys(SANDBOX_REFUSAL_STATUS).sort()).toEqual([...SandboxRefusal.options].sort());
    expect(SANDBOX_REFUSAL_STATUS.no_trigger).toBe(403);
    expect(SANDBOX_REFUSAL_STATUS.not_found).toBe(404);
    expect(SANDBOX_REFUSAL_STATUS.killed).toBe(403);
    expect(SANDBOX_REFUSAL_STATUS.member_data).toBe(403);
    expect(SANDBOX_REFUSAL_STATUS.approval_required).toBe(409);
    expect(SANDBOX_REFUSAL_STATUS.too_large).toBe(413);
    expect(SANDBOX_REFUSAL_STATUS.invalid_path).toBe(422);
    expect(SANDBOX_REFUSAL_STATUS.service_unavailable).toBe(503);
  });
});

describe("the other Agent Channel sandbox bodies are strict and bounded", () => {
  const turn = { eventId: ID, agentId: ID2 };

  it("process polls or kills one process", () => {
    expect(AgentChannelSandboxProcess.safeParse({ ...turn, processId: "p_01", action: "poll" }).success).toBe(
      true,
    );
    expect(
      AgentChannelSandboxProcess.safeParse({ ...turn, processId: "p_01", action: "signal" }).success,
    ).toBe(false);
  });

  it("read, write, list, delete, share and import name workspace paths only", () => {
    expect(AgentChannelSandboxRead.safeParse({ ...turn, path: "a.txt", offset: 0, limit: 10 }).success).toBe(
      true,
    );
    expect(
      AgentChannelSandboxRead.safeParse({ ...turn, path: "a.txt", limit: SANDBOX_LIMITS.readMaxBytes + 1 })
        .success,
    ).toBe(false);
    expect(AgentChannelSandboxRead.safeParse({ ...turn, path: "" }).success).toBe(false);
    expect(
      AgentChannelSandboxWrite.safeParse({ ...turn, path: "a.txt", content: "x", mode: "create" }).success,
    ).toBe(true);
    expect(
      AgentChannelSandboxWrite.safeParse({
        ...turn,
        path: "a.txt",
        content: "é".repeat(SANDBOX_LIMITS.writeMaxBytes / 2 + 1),
        mode: "overwrite",
      }).success,
    ).toBe(false);
    expect(
      AgentChannelSandboxWrite.safeParse({ ...turn, path: "/etc/passwd", content: "x", mode: "append" })
        .success,
    ).toBe(false);
    expect(AgentChannelSandboxList.parse({ ...turn, path: "" }).path).toBe("");
    expect(AgentChannelSandboxDelete.safeParse({ ...turn, path: "", recursive: true }).success).toBe(false);
    expect(AgentChannelSandboxShare.safeParse({ ...turn, path: "out/report.pdf" }).success).toBe(true);
    expect(AgentChannelSandboxImport.safeParse({ ...turn, attachmentId: ID }).success).toBe(true);
    expect(AgentChannelSandboxImport.safeParse({ ...turn, attachmentId: ID, userId: ID }).success).toBe(
      false,
    );
  });

  it("file lists and previews are bounded", () => {
    const entry = { path: "a.txt", name: "a.txt", kind: "file", size: 3, modifiedAt: NOW, hidden: false };
    expect(SandboxFileList.safeParse({ path: "", entries: [entry], more: 0 }).success).toBe(true);
    expect(
      SandboxFileList.safeParse({
        path: "",
        entries: Array(SANDBOX_LIMITS.listMaxEntries + 1).fill(entry),
        more: 0,
      }).success,
    ).toBe(false);
    for (const p of [
      { kind: "text", text: "hi", size: 2, modifiedAt: NOW },
      { kind: "image", mimeType: "image/png", size: 2, modifiedAt: NOW },
      { kind: "binary", size: 2, modifiedAt: NOW },
      { kind: "too_large", size: 9e9, modifiedAt: NOW },
    ]) {
      expect(SandboxFilePreview.safeParse(p).success, p.kind).toBe(true);
    }
    expect(
      SandboxFilePreview.safeParse({ kind: "image", mimeType: "image/svg+xml", size: 2, modifiedAt: NOW })
        .success,
    ).toBe(false);
  });
});

describe("sandbox settings, isolation and status (D-09, D-11, D-12, D-14)", () => {
  it("allow hosts are bare lower-case hosts, optional port, optional leading wildcard", () => {
    for (const h of ["example.com", "api.example.com:8443", "*.example.com", "10.0.0.1"]) {
      expect(AllowHost.safeParse(h).success, h).toBe(true);
    }
    for (const h of [
      "https://example.com",
      "example.com/path",
      "Example.com",
      "*.com",
      "*",
      "a.*.example.com",
      "example.com:0",
      "example.com:65536",
      "",
      "user@example.com",
    ]) {
      expect(AllowHost.safeParse(h).success, h).toBe(false);
    }
  });

  it("defaults: off, shell allowlist, browser public, the plan-02 limits", () => {
    expect(DEFAULT_SANDBOX_SETTINGS).toMatchObject({
      enabled: false,
      sandboxEgress: "allowlist",
      browserEgress: "public",
      allowHosts: [],
      limits: {
        maxSandboxes: 10,
        maxBrowsers: 3,
        cpuMinutesPerDay: 600,
        diskPerBotMb: 2048,
        diskTotalMb: 51_200,
      },
      browserSessionMaxDays: 30,
      killed: null,
    });
    const settings = SandboxSettings.parse({ ...DEFAULT_SANDBOX_SETTINGS, version: 0, updatedAt: null });
    expect(
      SandboxSettings.safeParse({
        ...settings,
        allowHosts: Array(SANDBOX_LIMITS.allowHostsMax + 1).fill("a.example"),
      }).success,
    ).toBe(false);
    expect(SandboxSettings.safeParse({ ...settings, browserSessionMaxDays: 91 }).success).toBe(false);
    expect(
      SandboxSettings.safeParse({ ...settings, limits: { ...settings.limits, maxSandboxes: 101 } }).success,
    ).toBe(false);
    expect(
      SandboxSettings.parse({ ...settings, killed: { at: NOW, by: { id: ID, displayName: "Ada" } } }).killed
        ?.by?.id,
    ).toBe(ID);
  });

  it("an update names the version it read and changes at least one thing", () => {
    expect(UpdateSandboxSettingsRequest.safeParse({ expectedVersion: 0 }).success).toBe(false);
    expect(UpdateSandboxSettingsRequest.safeParse({ expectedVersion: 0, enabled: true }).success).toBe(true);
    expect(
      UpdateSandboxSettingsRequest.safeParse({ expectedVersion: 0, enabled: true, killed: null }).success,
    ).toBe(false);
    expect(
      UpdateSandboxSettingsRequest.safeParse({ expectedVersion: 1, sandboxEgress: "open" }).success,
    ).toBe(false);
  });

  it("isolation reports the runtime and the browser sandbox posture; old payloads without it parse as unknown", () => {
    const iso = {
      status: "ok",
      runtime: "gvisor",
      dockerVersion: "29.8.2",
      running: { sandboxes: 1, browsers: 0 },
    };
    expect(SandboxIsolationInfo.parse(iso).browserSandbox).toBeNull();
    expect(SandboxIsolationInfo.parse({ ...iso, browserSandbox: "container-only" }).browserSandbox).toBe(
      "container-only",
    );
    expect(SandboxIsolationInfo.safeParse({ ...iso, browserSandbox: "none" }).success).toBe(false);
    const view = SandboxSettingsView.parse({
      settings: { ...DEFAULT_SANDBOX_SETTINGS, version: 3, updatedAt: NOW },
      isolation: iso,
      usage: { cpuMinutesToday: 4, diskBytesTotal: 1024 },
    });
    expect(view.isolation.runtime).toBe("gvisor");
  });

  it("the status view carries state, limits, stop reason and what the viewer may do", () => {
    const status = {
      agentId: ID,
      state: "stopped",
      runtime: "hardened-runc",
      lastActiveAt: NOW,
      diskBytes: 10,
      diskQuotaBytes: 2048 * 1024 * 1024,
      cpuMsToday: 100,
      org: { cpuMinutesToday: 2, cpuMinutesPerDay: 600 },
      limits: { cpus: 1, memoryBytes: 1024 ** 3, pids: 256, idleStopMinutes: 15 },
      packages: 0,
      teamBot: true,
      stopReason: "idle",
      viewerCan: { files: true, control: false },
    };
    expect(SandboxStatusView.parse(status)).toEqual(status);
    expect(SandboxStatusView.safeParse({ ...status, state: "paused" }).success).toBe(false);
    expect(SandboxStatusView.safeParse({ ...status, stopReason: "bored" }).success).toBe(false);
  });
});

describe("sandboxd protocol (D-11, Pattern 1)", () => {
  const OPS = [
    "info",
    "ensure",
    "exec",
    "process",
    "stop",
    "restart",
    "kill",
    "killOrg",
    "purge",
    "usage",
    "policy",
    "filesList",
    "filesStat",
    "filesRead",
    "filesWrite",
    "filesDelete",
    "filesUpload",
    "filesDownload",
    "filesImport",
    "events",
    "browserEnsure",
    "contextOpen",
    "contextNavigate",
    "contextSnapshot",
    "contextAct",
    "contextScreenshot",
    "contextWait",
    "contextExportState",
    "contextClose",
    "contextHold",
    "contextTakeover",
    "contextResize",
    "contextFrames",
    "contextInput",
    "contextDownload",
    "packageReview",
    "packageInstall",
    "packageRemove",
  ];

  it("names every op once, each with a method, a /v1 path and input and output schemas", () => {
    expect(Object.keys(SANDBOXD_ROUTES).sort()).toEqual([...OPS].sort());
    const paths = new Set<string>();
    for (const [op, route] of Object.entries(SANDBOXD_ROUTES)) {
      expect(["GET", "POST"], op).toContain(route.method);
      expect(route.path.startsWith("/v1/"), op).toBe(true);
      expect(typeof route.input.safeParse, op).toBe("function");
      expect(typeof route.output.safeParse, op).toBe("function");
      paths.add(`${route.method} ${route.path}`);
    }
    expect(paths.size).toBe(OPS.length);
    expect(SANDBOXD_ROUTES.exec.input).toBe(SandboxdExec);
    expect(SANDBOXD_ROUTES.exec.output).toBe(SandboxdExecResult);
  });

  it("labels are the five ocw.* names", () => {
    expect(SANDBOXD_LABELS).toEqual({
      sandbox: "ocw.sandbox",
      namespace: "ocw.namespace",
      org: "ocw.org",
      agent: "ocw.agent",
      kind: "ocw.kind",
    });
  });
});

describe("sandboxd policy, events, errors and frame framing", () => {
  const target = { orgId: ID, agentId: ID2 };
  const limits = {
    nanoCpus: 1e9,
    memoryBytes: 1024 ** 3,
    pids: 256,
    diskQuotaBytes: 2 * 1024 ** 3,
    idleStopMs: 900_000,
  };

  it("an org policy carries egress, hosts, limits and the kill state, nothing else", () => {
    const policy = {
      orgId: ID,
      sandboxEgress: "allowlist",
      browserEgress: "public",
      allowHosts: ["*.example.com"],
      privateHosts: ["intranet.example"],
      limits,
      browserLimits: limits,
      killed: false,
      version: 3,
    };
    expect(SandboxdOrgPolicy.parse(policy)).toEqual(policy);
    // The settings version orders pushes: sandboxd keeps the newest (a stale re-push never undoes a kill).
    expect(SandboxdOrgPolicy.safeParse({ ...policy, version: undefined }).success).toBe(false);
    expect(SandboxdOrgPolicy.safeParse({ ...policy, version: -1 }).success).toBe(false);
    expect(SandboxdOrgPolicy.safeParse({ ...policy, binds: ["/:/host"] }).success).toBe(false);
    expect(SandboxdOrgPolicy.safeParse({ ...policy, limits: { ...limits, privileged: true } }).success).toBe(
      false,
    );
  });

  it("events carry a boot id, a bounded batch and the next sequence", () => {
    const res = {
      bootId: "6f1c1f4e-8a43-4d0e-9b1a-2b7c0f3e5d11",
      events: [
        { seq: 1, at: NOW, type: "state", target, kind: "sbx", state: "stopped", reason: "idle" },
        { seq: 2, at: NOW, type: "usage", target, cpuMs: 120, diskBytes: 4096 },
        { seq: 3, at: NOW, type: "egress", target, kind: "brw", host: "example.com", allowed: false },
        {
          seq: 4,
          at: NOW,
          type: "browser",
          target,
          contextId: ID,
          event: "download",
          host: "example.com",
          download: { name: "a.pdf", size: 10, token: "tok_0123456789abcdef" },
        },
      ],
      nextSeq: 5,
    };
    expect(SandboxdEventsResponse.parse(res).events).toHaveLength(4);
    expect(SandboxdEventsResponse.safeParse({ ...res, events: Array(501).fill(res.events[1]) }).success).toBe(
      false,
    );
    expect(
      SandboxdEventsResponse.safeParse({ ...res, events: [{ ...res.events[1], cpuMs: -1 }] }).success,
    ).toBe(false);
  });

  it("error codes are exactly these; policy_missing is sandboxd holding no policy for the organization", () => {
    expect(SandboxdErrorCode.options).toEqual([
      "unauthorized",
      "invalid_request",
      "label_mismatch",
      "not_found",
      "exists",
      "invalid_path",
      "too_large",
      "disk_full",
      "busy",
      "killed",
      "policy_missing",
      "timeout",
      "docker_unavailable",
      "limit_reached",
      "no_context",
      "element_gone",
      "navigation_refused",
      "paused",
      "digest_mismatch",
      "tree_changed",
    ]);
  });

  it("errors carry a code and a message", () => {
    expect(SandboxdError.parse({ error: { code: "label_mismatch", message: "not ours" } }).error.code).toBe(
      "label_mismatch",
    );
    expect(SandboxdError.safeParse({ error: { code: "oops", message: "x" } }).success).toBe(false);
  });

  it("frames are a 4-byte big-endian length, a 1-byte type and the payload", () => {
    expect(FRAME_HEADER_BYTES).toBe(5);
    expect(FRAME_TYPES).toEqual({ jpeg: 0, control: 1 });
    const payload = new TextEncoder().encode('{"kind":"closed"}');
    const frame = encodeFrame(FRAME_TYPES.control, payload);
    expect(frame.length).toBe(FRAME_HEADER_BYTES + payload.length);
    expect([...frame.slice(0, 5)]).toEqual([0, 0, 0, payload.length, 1]);
    expect(decodeFrameHeader(frame)).toEqual({ length: payload.length, type: FRAME_TYPES.control });
    expect(decodeFrameHeader(frame.slice(0, 4))).toBeNull();
    expect(() => decodeFrameHeader(new Uint8Array([0, 0, 0, 1, 7]))).toThrow(RangeError);
    expect(() => decodeFrameHeader(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0]))).toThrow(RangeError);
    expect(() => encodeFrame(FRAME_TYPES.jpeg, new Uint8Array(FRAME_MAX_PAYLOAD_BYTES + 1))).toThrow(
      RangeError,
    );
  });
});

describe("sandbox packages: the whole dependency tree is pinned (P-12, T-07.8-01-06)", () => {
  const SHA256 = "b".repeat(64);
  const a = { name: "a", version: "1.0.0", integrity: `sha512-${"A".repeat(86)}==` };
  const b = { name: "b", version: "2.0.0", integrity: `sha256:${SHA256}` };
  const b1 = { name: "b", version: "1.0.0", integrity: `sha256:${"c".repeat(64)}` };

  it("the canonical tree ignores order and changes with any version or integrity", () => {
    const base = packageTreeCanonical([a, b, b1]);
    expect(packageTreeCanonical([b1, b, a])).toBe(base);
    expect(packageTreeCanonical([b, a, b1])).toBe(base);
    expect(packageTreeCanonical([a, { ...b, version: "2.0.1" }, b1])).not.toBe(base);
    expect(packageTreeCanonical([a, { ...b, integrity: `sha256:${"d".repeat(64)}` }, b1])).not.toBe(base);
    expect(JSON.parse(base)).toEqual([a, b1, b]);
    expect(packageTreeCanonical([])).toBe("[]");
  });

  it("tree entries take sha512 (npm) or sha256 integrity only", () => {
    expect(PackageTreeEntry.safeParse(a).success).toBe(true);
    expect(PackageTreeEntry.safeParse(b).success).toBe(true);
    expect(PackageTreeEntry.safeParse({ ...a, integrity: "sha1-abc=" }).success).toBe(false);
    expect(PackageTreeEntry.safeParse({ ...a, integrity: `sha256:${"B".repeat(64)}` }).success).toBe(false);
    expect(PackageTreeEntry.safeParse({ ...a, name: "x".repeat(215) }).success).toBe(false);
  });

  it("a review requires the dependency count and the tree hash, and binds them in its token", () => {
    const review = {
      source: "npm",
      name: "@scope/tool",
      version: "1.2.3",
      sha256: SHA256,
      sizeBytes: 10,
      license: null,
      publisher: null,
      hasInstallScript: true,
      dependencyCount: 12,
      treeSha256: SHA256,
      risk: "medium",
      riskReasons: ["Runs an install script"],
      reviewToken: "tok",
    };
    expect(SandboxPackageReview.parse(review).dependencyCount).toBe(12);
    const { dependencyCount: _d, ...noCount } = review;
    expect(SandboxPackageReview.safeParse(noCount).success).toBe(false);
    const { treeSha256: _t, ...noTree } = review;
    expect(SandboxPackageReview.safeParse(noTree).success).toBe(false);
    expect(SandboxPackageReview.safeParse({ ...review, treeSha256: "abc" }).success).toBe(false);
    expect(SandboxPackageReview.safeParse({ ...review, dependencyCount: 5001 }).success).toBe(false);
    expect(SandboxPackageReview.safeParse({ ...review, riskReasons: Array(11).fill("x") }).success).toBe(
      false,
    );
  });

  it("requests are strict and names are exact package names", () => {
    expect(
      ReviewSandboxPackageRequest.safeParse({ source: "pypi", name: "requests", version: "2.32.3" }).success,
    ).toBe(true);
    expect(
      ReviewSandboxPackageRequest.safeParse({
        source: "debian",
        name: "libxml2-utils",
        version: "2.9.14+dfsg-1.3~deb12u1",
      }).success,
    ).toBe(true);
    for (const name of ["", "a b", "a;rm -rf /", "../x", "-flag", "@scope/../x"]) {
      expect(
        ReviewSandboxPackageRequest.safeParse({ source: "npm", name, version: "1.0.0" }).success,
        name,
      ).toBe(false);
    }
    for (const version of ["", "^1.0.0", ">=1", "1.0.0 || 2", "*"]) {
      expect(
        ReviewSandboxPackageRequest.safeParse({ source: "npm", name: "a", version }).success,
        version,
      ).toBe(false);
    }
    expect(ReviewSandboxPackageRequest.safeParse({ source: "brew", name: "a", version: "1" }).success).toBe(
      false,
    );
    expect(
      ReviewSandboxPackageRequest.safeParse({ source: "npm", name: "a", version: "1", registry: "x" })
        .success,
    ).toBe(false);
    expect(
      ApproveSandboxPackageRequest.safeParse({ reviewToken: "t", acknowledge: "install anyway" }).success,
    ).toBe(true);
    expect(ApproveSandboxPackageRequest.safeParse({ reviewToken: "t", acknowledge: "yes" }).success).toBe(
      false,
    );
    expect(UpdateSandboxPackageRequest.safeParse({}).success).toBe(false);
    expect(UpdateSandboxPackageRequest.safeParse({ enabled: false }).success).toBe(true);
  });

  it("a package row says whether its tree moved upstream; the list is bounded", () => {
    const pkg = {
      id: ID,
      source: "npm",
      name: "left-pad",
      version: "1.3.0",
      sha256: SHA256,
      dependencyCount: 0,
      treeSha256: SHA256,
      risk: "low",
      enabled: true,
      personalAllowed: false,
      installedIn: 2,
      installing: 0,
      failed: 1,
      changedUpstream: true,
      newerVersion: "1.3.1",
      approvedBy: { id: ID2, displayName: "Ada" },
      approvedAt: NOW,
    };
    expect(SandboxPackage.parse(pkg).changedUpstream).toBe(true);
    expect(
      SandboxPackageList.safeParse({ items: Array(201).fill(pkg), viewerCan: { manage: true } }).success,
    ).toBe(false);
  });
});

describe("turn activity on replies (R2, UI-SPEC Surface 5)", () => {
  const step = {
    id: "s1",
    tool: "ocw_sandbox_exec",
    verb: "ran",
    target: "python report.py",
    outcome: { kind: "ok", code: null, exitCode: 0, durationMs: 1200 },
    signedIn: false,
    contextId: null,
    approvalMessageRoute: null,
    details: { command: "python report.py", cwd: "reports", exitCode: 0, outputTail: "done\n" },
  };
  const activity = (n: number) => ({
    eventId: ID,
    steps: Array(n).fill(step),
    more: 0,
    running: false,
    current: null,
  });
  const message = {
    id: ID,
    organizationId: ID,
    conversationId: ID,
    seq: 1,
    authorKind: "agent",
    authorId: ID2,
    body: "Done",
    mentions: [],
    status: "sent",
    threadId: null,
    replyCount: 0,
    lastReplyAt: null,
    clientKind: "agent",
    createdAt: NOW,
    editedAt: null,
  };

  it("a reply carries at most 50 steps; older messages without activity parse", () => {
    expect(Message.parse(message).activity).toBeUndefined();
    expect(Message.parse({ ...message, activity: activity(50) }).activity?.steps).toHaveLength(50);
    expect(Message.safeParse({ ...message, activity: activity(51) }).success).toBe(false);
  });

  it("steps are bounded: target, output tail and verbs", () => {
    expect(
      ActivityStep.safeParse({ ...step, details: { ...step.details, outputTail: "x".repeat(4097) } }).success,
    ).toBe(false);
    expect(
      ActivityStep.safeParse({ ...step, details: { ...step.details, outputTail: "x".repeat(4096) } }).success,
    ).toBe(true);
    expect(ActivityStep.safeParse({ ...step, target: "x".repeat(201) }).success).toBe(false);
    expect(ActivityStep.safeParse({ ...step, verb: "evaluated" }).success).toBe(false);
    expect(ActivityVerb.options).toContain("blocked_egress");
    expect(BotTurnActivity.safeParse({ ...activity(1), current: "x".repeat(81) }).success).toBe(false);
  });

  it("the live event names the conversation, thread and agent", () => {
    const ev = {
      type: "turn.activity",
      conversationId: ID,
      threadRootMessageId: null,
      agentId: ID2,
      activity: { ...activity(1), running: true, current: "Running python report.py" },
    };
    expect(TurnActivityEvent.parse(ev).activity.running).toBe(true);
    expect(TurnActivityEvent.safeParse({ ...ev, type: "turn.updated" }).success).toBe(false);
  });
});
