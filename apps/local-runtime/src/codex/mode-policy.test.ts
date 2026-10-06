import { describe, expect, it } from "vitest";
import {
  CODEX_POLICY_MODES,
  codexModeFromSettings,
  codexModePolicy,
  isUnrestrictedCodexPolicy,
} from "./mode-policy.js";

const CWD = "/tmp/ocw-mode-policy";

describe("codexModePolicy — the platform mode → Codex sandbox / approvals table (D-12)", () => {
  it("plan: read-only sandbox, asks on request, reviewed by the user", () => {
    expect(codexModePolicy("plan", CWD)).toEqual({
      sandbox: "read-only",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
  });

  it("default (Supervised): read-only sandbox with untrusted approvals, so it asks before commands and edits", () => {
    expect(codexModePolicy("default", CWD)).toEqual({
      sandbox: "read-only",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
    });
  });

  it("acceptEdits: workspace-write limited to the working tree, asks on request", () => {
    expect(codexModePolicy("acceptEdits", CWD)).toEqual({
      sandbox: "workspace-write",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [CWD],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
  });

  it("auto: like acceptEdits but approval requests go to Codex's auto reviewer", () => {
    const auto = codexModePolicy("auto", CWD);
    expect(auto.approvalsReviewer).toBe("auto_review");
    expect(auto.sandbox).toBe("workspace-write");
    expect(auto.sandboxPolicy.type).toBe("workspaceWrite");
    expect(auto.approvalPolicy).toBe("on-request");
  });

  it("Supervised and Auto-accept edits never share a sandbox or an approval policy again (Pitfall 1)", () => {
    const supervised = codexModePolicy("default", CWD);
    const acceptEdits = codexModePolicy("acceptEdits", CWD);
    expect(supervised.sandbox).not.toBe(acceptEdits.sandbox);
    expect(supervised.sandboxPolicy.type).not.toBe(acceptEdits.sandboxPolicy.type);
    expect(supervised.approvalPolicy).not.toBe(acceptEdits.approvalPolicy);
  });

  it("no mode but fullAccess yields a full-access sandbox or the never policy", () => {
    for (const mode of CODEX_POLICY_MODES) {
      const p = codexModePolicy(mode, CWD);
      expect(p.sandbox).not.toBe("danger-full-access");
      expect(p.sandboxPolicy.type).not.toBe("dangerFullAccess");
      expect(p.approvalPolicy).not.toBe("never");
      expect(isUnrestrictedCodexPolicy(p)).toBe(false);
    }
  });

  it("fullAccess (ADR-0012 path only): danger-full-access sandbox, never asks, user reviewer", () => {
    const p = codexModePolicy("fullAccess", CWD);
    expect(p).toEqual({
      sandbox: "danger-full-access",
      sandboxPolicy: { type: "dangerFullAccess" },
      approvalPolicy: "never",
      approvalsReviewer: "user",
    });
    expect(isUnrestrictedCodexPolicy(p)).toBe(true);
    expect(codexModeFromSettings(p.approvalPolicy, p.sandboxPolicy, p.approvalsReviewer)).toBe("fullAccess");
  });
});

describe("codexModeFromSettings — the inverse table (effective readback)", () => {
  it("recovers every mode from what codexModePolicy sends", () => {
    for (const mode of CODEX_POLICY_MODES) {
      const p = codexModePolicy(mode, CWD);
      expect(codexModeFromSettings(p.approvalPolicy, p.sandboxPolicy, p.approvalsReviewer)).toBe(mode);
    }
  });

  it("reports an unrestricted sandbox or the never policy as fullAccess, so the server can fail closed", () => {
    expect(codexModeFromSettings("never", { type: "dangerFullAccess" }, "user")).toBe("fullAccess");
    expect(codexModeFromSettings("on-request", { type: "dangerFullAccess" }, "user")).toBe("fullAccess");
    expect(codexModeFromSettings("never", { type: "readOnly", networkAccess: false }, "user")).toBe(
      "fullAccess",
    );
  });

  it("returns null for combinations no platform mode produces", () => {
    expect(
      codexModeFromSettings("on-request", { type: "readOnly", networkAccess: false }, "auto_review"),
    ).toBeNull();
    expect(
      codexModeFromSettings(
        "untrusted",
        {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        "user",
      ),
    ).toBeNull();
    expect(
      codexModeFromSettings(
        {
          granular: {
            sandbox_approval: true,
            rules: true,
            skill_approval: true,
            request_permissions: true,
            mcp_elicitations: true,
          },
        },
        { type: "readOnly", networkAccess: false },
        "user",
      ),
    ).toBeNull();
  });

  it("isUnrestrictedCodexPolicy flags dangerFullAccess or never", () => {
    expect(
      isUnrestrictedCodexPolicy({
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      }),
    ).toBe(true);
    expect(
      isUnrestrictedCodexPolicy({ approvalPolicy: "untrusted", sandboxPolicy: { type: "dangerFullAccess" } }),
    ).toBe(true);
    expect(isUnrestrictedCodexPolicy({ approvalPolicy: "untrusted", sandboxPolicy: null })).toBe(false);
  });
});
