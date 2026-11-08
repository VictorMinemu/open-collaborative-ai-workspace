import { ActivityStep, BotTurnActivity, SANDBOX_LIMITS } from "@ocw/contracts";
import { measureScaling } from "@ocw/contracts/testing/scaling";
import { describe, expect, it } from "vitest";
import { currentPhrase, maskActivityText, mergeStep, stepFor } from "./activity";

/**
 * 07.8-10 (R2, UI-SPEC Surface 5, T-07.8-10-01): the turn activity is composed by the API from the call it decided,
 * every string masked by 07.5's `maskForDisplay`, paths relative to `/workspace`, hosts only, bounded per contract.
 */

const ok = (extra: Record<string, unknown> = {}) => ({ kind: "ok" as const, durationMs: 12, ...extra });
const bytes = (s: string) => new TextEncoder().encode(s).length;
const SECRET = "sk-live-ABCDEF0123456789";

describe("stepFor: verbs and targets (UI-SPEC Surface 5)", () => {
  it("a write is `wrote` + the relative path and its size", () => {
    const step = stepFor("ocw_sandbox_write", { path: "reports/late.csv", content: "x".repeat(4096) }, ok());
    expect(step.verb).toBe("wrote");
    expect(step.target).toBe("reports/late.csv · 4 KB");
    expect(step.tool).toBe("ocw_sandbox_write");
    expect(step.outcome).toEqual({ kind: "ok", code: null, exitCode: null, durationMs: 12 });
    expect(step.details).toBeNull();
    expect(ActivityStep.parse(step)).toEqual(step);
  });

  it("read, list, delete, process and share have their verbs; the root folder reads as the workspace", () => {
    expect(stepFor("ocw_sandbox_read", { path: "a/b.txt" }, ok()).verb).toBe("read");
    expect(stepFor("ocw_sandbox_list", { path: "" }, ok())).toMatchObject({
      verb: "listed",
      target: "workspace",
    });
    expect(stepFor("ocw_sandbox_delete", { path: "old" }, ok())).toMatchObject({
      verb: "deleted",
      target: "old",
    });
    expect(stepFor("ocw_sandbox_process", { processId: "p1", action: "poll" }, ok()).verb).toBe(
      "checked_process",
    );
    expect(stepFor("ocw_sandbox_process", { processId: "p1", action: "kill" }, ok()).verb).toBe(
      "stopped_process",
    );
    expect(
      stepFor("ocw_sandbox_share", { path: "reports/late.csv" }, ok({ result: { name: "late.csv" } })),
    ).toMatchObject({ verb: "shared", target: "late.csv" });
  });

  it("a refused call is a `blocked` step with its code and the same target", () => {
    const step = stepFor(
      "ocw_sandbox_write",
      { path: "x.txt", content: "hi" },
      { kind: "blocked", code: "killed" },
    );
    expect(step.verb).toBe("blocked");
    expect(step.target).toBe("x.txt");
    expect(step.outcome).toEqual({ kind: "blocked", code: "killed", exitCode: null, durationMs: null });
  });

  it("an approval refusal is an `approval` outcome, not an error", () => {
    const step = stepFor(
      "ocw_sandbox_exec",
      { argv: ["ls"] },
      { kind: "approval", code: "approval_required" },
    );
    expect(step.outcome.kind).toBe("approval");
    expect(step.outcome.code).toBe("approval_required");
  });
});

describe("exec steps: masked command, last 20 lines, at most 4 KB (T-07.8-10-01)", () => {
  it("a command with a secret shows the masker's placeholder, never the secret", () => {
    const step = stepFor(
      "ocw_sandbox_exec",
      {
        argv: [
          "curl",
          "-H",
          `Authorization: Bearer ${SECRET}`,
          "https://api.example.com/v1/orders?token=abc",
        ],
      },
      ok({ result: { status: "exited", exitCode: 0, stdout: "done\n", stderr: "" } }),
    );
    const all = JSON.stringify(step);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("ABCDEF0123456789");
    expect(step.details?.command).toContain("sk-•••• 6789");
    // Hosts only: no path, no query string.
    expect(all).not.toContain("/v1/orders");
    expect(all).not.toContain("token=abc");
    expect(step.details?.command).toContain("api.example.com");
    expect(step.verb).toBe("ran");
    expect(step.target.startsWith("curl -H")).toBe(true);
    expect(step.details?.exitCode).toBe(0);
  });

  it("300 lines of output keep the last 20 and at most 4 KB", () => {
    const stdout = Array.from({ length: 300 }, (_, i) => `line ${i} ${"y".repeat(400)}`).join("\n");
    const step = stepFor(
      "ocw_sandbox_exec",
      { argv: ["seq", "300"] },
      ok({ result: { status: "exited", exitCode: 0, stdout, stderr: "" } }),
    );
    const tail = step.details?.outputTail ?? "";
    expect(bytes(tail)).toBeLessThanOrEqual(SANDBOX_LIMITS.activityOutputBytes);
    expect(tail.split("\n").length).toBeLessThanOrEqual(20);
    expect(tail.endsWith(`line 299 ${"y".repeat(400)}`)).toBe(true);
    expect(tail).not.toContain("line 279 ");
  });

  it("a non-zero exit is an error with its exit code; a yielded command is running", () => {
    const failed = stepFor(
      "ocw_sandbox_exec",
      { argv: ["false"] },
      ok({ result: { status: "exited", exitCode: 1, stdout: "", stderr: "" } }),
    );
    expect(failed.outcome).toMatchObject({ kind: "error", exitCode: 1 });
    const running = stepFor(
      "ocw_sandbox_exec",
      { argv: ["sleep", "60"], background: true },
      ok({ result: { status: "running", processId: "p1", stdout: "", stderr: "" } }),
    );
    expect(running.outcome.kind).toBe("running");
  });

  it("environment assignments in a command or its output never show their values", () => {
    const step = stepFor(
      "ocw_sandbox_exec",
      { argv: ["sh", "-c", "API_TOKEN=hunter2-not-a-key ./run.sh"] },
      ok({
        result: {
          status: "exited",
          exitCode: 0,
          stdout: "HOME=/home/bot\nPATH=/usr/bin\nready\n",
          stderr: "",
        },
      }),
    );
    const all = JSON.stringify(step);
    expect(all).not.toContain("hunter2-not-a-key");
    expect(all).not.toContain("/home/bot");
    expect(step.details?.outputTail).toContain("ready");
  });

  it("the working folder is relative; `/workspace/` paths are shown relative to it", () => {
    const step = stepFor(
      "ocw_sandbox_exec",
      { argv: ["cat", "/workspace/reports/late.csv"], cwd: "reports" },
      ok({ result: { status: "exited", exitCode: 0, stdout: "", stderr: "" } }),
    );
    expect(step.details?.cwd).toBe("reports");
    expect(step.details?.command).toBe("cat reports/late.csv");
  });
});

describe("masking of paths", () => {
  it("a path never starts with `/` and a secret-looking file name is masked", () => {
    for (const path of ["/etc/passwd", "/workspace/a.txt", "a.txt"]) {
      const step = stepFor("ocw_sandbox_read", { path }, ok());
      expect(step.target.startsWith("/")).toBe(false);
    }
    expect(stepFor("ocw_sandbox_read", { path: `keys/${SECRET}.txt` }, ok()).target).not.toContain(SECRET);
    expect(maskActivityText(`see /workspace/x and ${SECRET}`)).toBe("see x and sk-•••• 6789");
  });
});

describe("currentPhrase (UI-SPEC activity phrases, at most 80 characters)", () => {
  it("names what the bot does now", () => {
    const step = stepFor(
      "ocw_sandbox_write",
      { path: "reports/late.csv", content: "a" },
      { kind: "running" },
    );
    expect(currentPhrase(step)).toBe("writing reports/late.csv");
    const long = stepFor("ocw_sandbox_exec", { argv: ["echo", "z".repeat(300)] }, { kind: "running" });
    expect(currentPhrase(long).length).toBeLessThanOrEqual(80);
  });
});

describe("mergeStep: at most 50 steps, then `more`", () => {
  it("51 calls keep 50 steps and count one more; a later update of a stored step replaces it", () => {
    let state = { steps: [] as ActivityStep[], more: 0 };
    const first = stepFor("ocw_sandbox_list", { path: "" }, { kind: "running" });
    state = mergeStep(state, first);
    for (let i = 1; i < 51; i++) state = mergeStep(state, stepFor("ocw_sandbox_list", { path: "" }, ok()));
    expect(state.steps).toHaveLength(SANDBOX_LIMITS.activityStepsMax);
    expect(state.more).toBe(1);
    state = mergeStep(state, { ...first, outcome: { ...first.outcome, kind: "ok" } });
    expect(state.steps[0]?.outcome.kind).toBe("ok");
    expect(state.steps).toHaveLength(50);
    expect(state.more).toBe(1);
    expect(
      BotTurnActivity.parse({ eventId: crypto.randomUUID(), ...state, running: true, current: null }).steps,
    ).toHaveLength(50);
  });
});

describe("browser steps (07.8-14, UI-SPEC Surface 5)", () => {
  const ctx = { contextId: "0b5c2e0e-6f4b-4b8f-9a62-3a8f5d5f0c11", signedIn: true };

  it("verbs and targets: hosts only, element names as plain text, never the typed text", () => {
    const open = stepFor("ocw_browser_open", { host: "panel.fake.test" }, { kind: "ok" }, ctx);
    expect(open).toMatchObject({ verb: "opened", target: "panel.fake.test", ...ctx });
    expect(stepFor("ocw_browser_snapshot", { host: "panel.fake.test" }, { kind: "ok" }).verb).toBe(
      "read_page",
    );
    expect(stepFor("ocw_browser_screenshot", { host: "panel.fake.test" }, { kind: "ok" }).verb).toBe(
      "screenshot",
    );
    expect(stepFor("ocw_browser_wait", { host: "panel.fake.test" }, { kind: "ok" }).verb).toBe("waited");
    expect(stepFor("ocw_browser_close", { host: "panel.fake.test" }, { kind: "ok" }).verb).toBe("closed");
    const click = stepFor(
      "ocw_browser_act",
      { host: "panel.fake.test", action: "click", elementName: "Orders" },
      { kind: "ok" },
    );
    expect([click.verb, click.target]).toEqual(["clicked", "“Orders” on panel.fake.test"]);
    const typed = stepFor(
      "ocw_browser_act",
      { host: "panel.fake.test", action: "type", elementName: "Search", text: "OCW-TYPED-SECRET" },
      { kind: "ok" },
    );
    expect([typed.verb, typed.target]).toEqual(["typed", "“Search” on panel.fake.test"]);
    expect(JSON.stringify(typed)).not.toContain("OCW-TYPED-SECRET");
    expect(
      stepFor("ocw_browser_act", { host: "panel.fake.test", action: "press", key: "Enter" }, { kind: "ok" })
        .target,
    ).toBe("Enter on panel.fake.test");
    expect(
      stepFor("ocw_browser_act", { host: "panel.fake.test", action: "select", option: "XL" }, { kind: "ok" })
        .verb,
    ).toBe("chose");
    // Anything that is not a host reads "a page" (never a path or a query).
    expect(stepFor("ocw_browser_open", { host: "x.test/a?b=c" }, { kind: "ok" }).target).toBe("a page");
  });

  it("a step waiting for approval links its card; any other outcome links nothing", () => {
    const route = "/chat/dm/0b5c2e0e-6f4b-4b8f-9a62-3a8f5d5f0c11?m=1f5c2e0e-6f4b-4b8f-9a62-3a8f5d5f0c11";
    const waiting = stepFor(
      "ocw_browser_act",
      { host: "shop.fake.test", action: "click", elementName: "Place order" },
      { kind: "approval", code: "approval_required", approvalMessageRoute: route },
      ctx,
    );
    expect(waiting.approvalMessageRoute).toBe(route);
    expect(waiting.verb).toBe("clicked");
    const done = stepFor(
      "ocw_browser_act",
      { host: "shop.fake.test", action: "click" },
      {
        kind: "ok",
        approvalMessageRoute: route,
      },
    );
    expect(done.approvalMessageRoute).toBeNull();
    expect(currentPhrase(waiting)).toBe("clicking “Place order” on shop.fake.test");
  });
});

describe("exec output tail: linear on a hostile newline run (sandbox output is the bot's)", () => {
  // `/\n+$/` rescanned a run of newlines from every start position (quadratic: ~1.4 s at 64 000).
  const exec = (stdout: string) =>
    stepFor(
      "ocw_sandbox_exec",
      { argv: ["yes"] },
      ok({ result: { status: "exited", exitCode: 0, stdout, stderr: "" } }),
    );
  const sized = (run: string, size: number) => `${run.repeat(size)}x`;

  it("a run of newlines then one character scales linearly (64 000 → 256 KiB)", () => {
    const CEILING = 2000;
    const small = sized("\n", 64_000);
    const large = sized("\n", 256 * 1024);
    // The smallest ratio of five small-then-large rounds after a warm-up, so one noisy round cannot fail it; a run over
    // the ceiling ends the measurement at once, so a quadratic rule (tens of seconds at 256 KiB) fails in seconds.
    const { ratio, ratios, largeMs } = measureScaling(
      () => exec(small),
      () => exec(large),
      { ceilingMs: CEILING },
    );
    expect(largeMs).toBeLessThan(CEILING);
    expect(ratio, `per-round ratios ${ratios.map((r) => r.toFixed(1)).join(", ")}`).toBeLessThan(10);
  }, 60_000);

  it("only the trailing newlines go", () => {
    expect(exec("a\n\nb\n\n\n").details?.outputTail).toBe("a\n\nb");
    expect(exec("\n\n\n").details?.outputTail).toBe("");
    expect(exec("a \n").details?.outputTail).toBe("a ");
  });
});
