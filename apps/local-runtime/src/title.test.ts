import type { RuntimeCatalog, RuntimeId, SessionTitlePayload } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import type { AgentRuntime, TitleRequest } from "./runtime.js";
import { runTitle, TITLE_INSTRUCTIONS, TitleError, titleUserMessage } from "./title.js";

/** runTitle: the daemon's own checks around an adapter's title call (Phase 03.2 Plan 12, D-18 … D-20, P-17, P-19). */

const HOME = "/Users/tester";
const ROOT = "/Users/tester/work/acme";

function stubRuntime(
  generate: ((req: TitleRequest) => Promise<string>) | null,
  models: string[] = ["opus", "haiku"],
  id: RuntimeId = "claude-code",
): AgentRuntime & { requests: TitleRequest[] } {
  const requests: TitleRequest[] = [];
  const catalog: RuntimeCatalog = {
    runtime: id,
    runtimeVersion: "1",
    models: models.map((m) => ({
      id: m,
      displayName: m,
      description: null,
      legacy: false,
      isDefault: false,
      badge: null,
      efforts: [],
      defaultEffort: null,
      contextWindows: [],
      defaultContextWindow: null,
      fastMode: { supported: false, reason: null },
      supportsAutoMode: false,
    })),
    permissionModes: ["default"],
    fastModeCost: null,
    collectedAt: new Date().toISOString(),
  };
  const rt = {
    id,
    capabilities: {
      supportsSteer: false,
      supportsResume: false,
      supportsPermissionModes: ["default"],
      supportsImages: false,
    },
    requests,
    detect: async () => ({ id, installed: true, version: "1", loggedIn: true }),
    start: async () => {},
    prompt: async () => {},
    interrupt: async () => {},
    resolveApproval: () => false,
    catalog: async () => catalog,
    stop: async () => {},
    stopAll: async () => {},
  } as AgentRuntime & { requests: TitleRequest[] };
  if (generate) {
    rt.generateTitle = (req: TitleRequest) => {
      requests.push(req);
      return generate(req);
    };
  }
  return rt;
}

const payload = (extra: Partial<SessionTitlePayload> = {}): SessionTitlePayload => ({
  runtime: "claude-code",
  model: "haiku",
  prompt: "Please fix the login redirect bug",
  ...extra,
});

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(TitleError);
    expect((err as TitleError).message.startsWith(`${(err as TitleError).code}:`)).toBe(true);
    return (err as TitleError).code;
  }
  throw new Error("expected a TitleError");
}

const run = (runtime: AgentRuntime | undefined, extra: Partial<Parameters<typeof runTitle>[0]> = {}) =>
  runTitle({ runtime, payload: payload(), roots: [ROOT], home: HOME, timeoutMs: 1000, ...extra });

describe("runTitle", () => {
  it("normalizes the raw answer and passes the model, the prompt and an abort signal", async () => {
    const rt = stubRuntime(async () => '"Fix login redirect bug."');
    expect(await run(rt)).toBe("Fix login redirect bug");
    expect(await run(stubRuntime(async () => "Fix login redirect bug settings page"))).toBe(
      "Fix login redirect bug settings",
    );
    expect(rt.requests).toHaveLength(1);
    expect(rt.requests[0]).toMatchObject({ model: "haiku", prompt: "Please fix the login redirect bug" });
    expect(rt.requests[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses a model the runtime's catalog does not list", async () => {
    const rt = stubRuntime(async () => "Fix login redirect bug", ["opus", "sonnet"]);
    expect(await failure(run(rt))).toBe("title_model_not_in_catalog");
    expect(rt.requests).toEqual([]);
  });

  it("refuses a payload runtime other than the active session's runtime", async () => {
    const rt = stubRuntime(async () => "Fix login redirect bug");
    expect(await failure(run(rt, { sessionRuntime: "codex" }))).toBe("title_runtime_mismatch");
    expect(rt.requests).toEqual([]);
  });

  it("refuses a title that contain() would change (project root or home path)", async () => {
    const inRoot = stubRuntime(async () => `Fix ${ROOT}/src login bug`);
    expect(await failure(run(inRoot))).toBe("title_sanitized");
    const inHome = stubRuntime(async () => `Clean ${HOME}/cache build output`);
    expect(await failure(run(inHome))).toBe("title_sanitized");
  });

  it("refuses a title that redact() would mask (a credential-like token, D-20 'no secrets')", async () => {
    // Fake credential assembled at runtime so secret scanners do not flag the test.
    const key = ["sk", "ant", "api03", "abcdefghijklmnop"].join("-");
    const rt = stubRuntime(async () => `Rotate ${key} key`);
    expect(await failure(run(rt))).toBe("title_sanitized");
    const ghp = stubRuntime(async () => `Revoke ghp_${"a1".repeat(12)} token now`);
    expect(await failure(run(ghp))).toBe("title_sanitized");
  });

  it("refuses an unusable answer", async () => {
    expect(await failure(run(stubRuntime(async () => "Fix")))).toBe("title_invalid_shape");
    expect(await failure(run(stubRuntime(async () => "Internationalization localization")))).toBe(
      "title_invalid_shape",
    );
    expect(await failure(run(stubRuntime(async () => "")))).toBe("title_invalid_shape");
  });

  it("refuses a runtime without generateTitle, or none at all", async () => {
    expect(await failure(run(stubRuntime(null)))).toBe("title_unsupported");
    expect(await failure(run(undefined))).toBe("title_unsupported");
  });

  it("times out a never-settling call at the given timeout and fires the abort signal", async () => {
    const rt = stubRuntime(() => new Promise<string>(() => {}));
    const started = Date.now();
    expect(await failure(run(rt, { timeoutMs: 80 }))).toBe("title_timeout");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(rt.requests[0]!.signal.aborted).toBe(true);
  });

  it("maps any other adapter error to title_failed and keeps an adapter's own code", async () => {
    expect(await failure(run(stubRuntime(async () => Promise.reject(new Error("boom")))))).toBe(
      "title_failed",
    );
    expect(
      await failure(run(stubRuntime(async () => Promise.reject(new TitleError("title_used_tool", "Bash"))))),
    ).toBe("title_used_tool");
  });
});

describe("title prompt", () => {
  it("instructions ask for the title only, in the request's language, without tools", () => {
    expect(TITLE_INSTRUCTIONS).toMatch(/2 to 5 words/);
    expect(TITLE_INSTRUCTIONS).toMatch(/same language/);
    expect(TITLE_INSTRUCTIONS).toMatch(/at most 32 characters/);
    expect(TITLE_INSTRUCTIONS).not.toMatch(/48|3 to 6/);
    expect(TITLE_INSTRUCTIONS).toMatch(/do not use tools/i);
  });

  it("wraps the request between delimiters", () => {
    const msg = titleUserMessage("Fix the login");
    expect(msg).toContain("<request>\nFix the login\n</request>");
  });
});
