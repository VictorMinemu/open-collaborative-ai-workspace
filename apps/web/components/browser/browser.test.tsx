import type { ActivityStep, BotTurnActivity } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityStepRow } from "./activity-step";
import { activityLabel, BotActivity } from "./bot-activity";

/**
 * The bot's sandbox and browser activity in chat (07.8-20; R2, UI-SPEC Surface 5): the server composes and masks every
 * step; the browser only lays it out, as text nodes. Static markup in node, like the other web component tests.
 */

const EVENT = "01a11635-d6e7-7c87-9f17-b6b1dc048941";

function step(over: Partial<ActivityStep> = {}): ActivityStep {
  return {
    id: crypto.randomUUID(),
    tool: "ocw_sandbox_write",
    verb: "wrote",
    target: "reports/late.csv · 4 KB",
    outcome: { kind: "ok", code: null, exitCode: null, durationMs: 120 },
    signedIn: false,
    contextId: null,
    approvalMessageRoute: null,
    details: null,
    ...over,
  };
}

const failedExec = (over: Partial<ActivityStep> = {}) =>
  step({
    tool: "ocw_sandbox_exec",
    verb: "ran",
    target: "python fetch.py",
    outcome: { kind: "error", code: null, exitCode: 1, durationMs: 2100 },
    details: {
      command: "python fetch.py --since 2026-10-01",
      cwd: "scripts",
      exitCode: 1,
      outputTail: "Traceback (most recent call last):\nValueError: bad date",
    },
    ...over,
  });

function activity(steps: ActivityStep[], over: Partial<BotTurnActivity> = {}): BotTurnActivity {
  return { eventId: EVENT, steps, more: 0, running: false, current: null, ...over };
}

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
/** The visible text, tags removed and entities decoded. */
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const row = (s: ActivityStep, open = false) =>
  html(
    <ol>
      <ActivityStepRow step={s} viewer={{ meId: null, requester: null }} defaultOpen={open} />
    </ol>,
  );

describe("activityLabel (UI-SPEC Surface 5 › Group label)", () => {
  it("sandbox only, browser only, both; 1 step is singular; `more` counts", () => {
    expect(activityLabel(activity([step(), step()]))).toBe("Used its sandbox · 2 steps");
    expect(activityLabel(activity([step()]))).toBe("Used its sandbox · 1 step");
    expect(
      activityLabel(activity([step({ tool: "ocw_browser_open", verb: "opened", target: "a.test" })])),
    ).toBe("Used its browser · 1 step");
    expect(
      activityLabel(
        activity([step(), step({ tool: "ocw_browser_open", verb: "opened", target: "a.test" })], { more: 4 }),
      ),
    ).toBe("Used its sandbox and browser · 6 steps");
  });
});

describe("BotActivity", () => {
  it("is a collapsed group button with aria-expanded and aria-controls; the steps are an <ol aria-label='Steps'>", () => {
    const markup = html(<BotActivity activity={activity([step(), failedExec()])} />);
    expect(markup).toContain('data-testid="bot-activity"');
    expect(text(markup)).toContain("Used its sandbox · 2 steps");
    const button = /<button[^>]*data-testid="bot-activity-toggle"[^>]*>/.exec(markup)?.[0] ?? "";
    expect(button).toContain('aria-expanded="false"');
    const controls = /aria-controls="([^"]+)"/.exec(button)?.[1];
    expect(controls).toBeTruthy();
    expect(markup).toMatch(new RegExp(`<ol[^>]*id="${controls}"[^>]*aria-label="Steps"`));
    // Collapsed: the list is in the markup, hidden.
    expect(markup).toMatch(/<ol[^>]*hidden=""/);
  });

  it("expanded: one activity-step per step with its verb and mono target", () => {
    const markup = html(<BotActivity activity={activity([step(), failedExec()])} defaultOpen />);
    expect(markup).toContain('aria-expanded="true"');
    expect(markup.match(/data-testid="activity-step"/g)).toHaveLength(2);
    expect(text(markup)).toContain("Wrote reports/late.csv · 4 KB");
    expect(text(markup)).toContain("Ran python fetch.py");
    expect(markup).toMatch(/font-mono[^"]*"[^>]*>reports\/late.csv · 4 KB</);
  });

  it("50 steps and `more: 3` end with the overflow row", () => {
    const steps = Array.from({ length: 50 }, () => step());
    const markup = html(<BotActivity activity={activity(steps, { more: 3 })} defaultOpen />);
    expect(markup.match(/data-testid="activity-step"/g)).toHaveLength(50);
    expect(text(markup)).toContain("3 more steps aren't shown.");
    expect(text(markup)).toContain("Used its sandbox · 53 steps");
  });

  it("renders nothing for a turn with no steps", () => {
    expect(html(<BotActivity activity={activity([])} />)).toBe("");
  });
});

describe("ActivityStepRow", () => {
  it("a failed exec: 'Exit 1' in red; details hold $ command, 'in {cwd} · exit 1 · {duration}' and the output tail in a <pre>", () => {
    const closed = row(failedExec());
    expect(text(closed)).toContain("Exit 1");
    expect(closed).toMatch(/text-red-600[^"]*dark:text-red-400/);
    const toggle = /<button[^>]*aria-expanded="false"[^>]*>/.exec(closed)?.[0] ?? "";
    expect(toggle).toContain("aria-controls=");
    expect(toggle).toContain('aria-label="Ran python fetch.py, failed, exit 1"');

    const open = row(failedExec(), true);
    expect(open).toContain('aria-expanded="true"');
    expect(text(open)).toContain("$ python fetch.py --since 2026-10-01");
    expect(text(open)).toContain("in scripts · exit 1 · 2.1 s");
    expect(open).toMatch(/<pre[^>]*>Traceback \(most recent call last\):\nValueError: bad date<\/pre>/);
  });

  it("an ok write shows a check and its duration; no toggle without details", () => {
    const markup = row(step());
    expect(markup).toMatch(/text-emerald-600[^"]*dark:text-emerald-400/);
    expect(text(markup)).toContain("120 ms");
    expect(markup).not.toContain("<button");
  });

  it("step text is text: a <script> in a target or output never becomes markup", () => {
    const evil = "<script>alert(1)</script>";
    const markup = row(
      failedExec({ target: evil, details: { command: evil, exitCode: 1, outputTail: evil } }),
      true,
    );
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("an exec without a cwd reads 'in workspace'", () => {
    const markup = row(failedExec({ details: { command: "ls", exitCode: 2 } }), true);
    expect(text(markup)).toContain("in workspace · exit 2 · 2.1 s");
    expect(text(markup)).toContain("No output");
  });
});
