import type { ActivityStep, BotTurnActivity } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityStepRow } from "./activity-step";
import { activityLabel, BotActivity, BotActivityLive, liveLabel, livePhrase } from "./bot-activity";
import { HostChip } from "./host-chip";

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

describe("HostChip (UI-SPEC §1.1)", () => {
  it("https: a lock and the host only", () => {
    const markup = html(<HostChip host="panel.autofy.app" secure />);
    expect(markup).toContain('data-secure="true"');
    expect(markup).toContain("lucide-lock-keyhole");
    expect(text(markup)).toBe("panel.autofy.app");
    expect(markup).not.toContain("Not secure");
  });

  it("http: the amber glyph and the word 'Not secure'", () => {
    const markup = html(<HostChip host="intranet.example.com" secure={false} />);
    expect(markup).toContain('data-secure="false"');
    expect(markup).toContain("lucide-triangle-alert");
    expect(markup).toMatch(/text-amber-700[^"]*dark:text-amber-300/);
    expect(text(markup)).toBe("Not secure intranet.example.com");
  });

  it("a 60-character host truncates at its end, keeps the whole host in the DOM and is a tooltip trigger", () => {
    const host = `${"a".repeat(49)}.example.com`;
    expect(host).toHaveLength(61);
    const markup = html(<HostChip host={host} secure />);
    const span = /<span[^>]*data-testid="host-chip-host"[^>]*>([^<]*)<\/span>/.exec(markup);
    expect(span?.[0]).toContain("truncate");
    expect(span?.[1]).toBe(host);
    // Base UI's trigger props (the Tooltip shows the full host on hover).
    expect(span?.[0]).toMatch(/data-(?:popup-)?(?:closed|state)|aria-describedby|data-base-ui/);
  });
});

describe("browser steps (UI-SPEC Surface 5 › Steps)", () => {
  const b = (verb: ActivityStep["verb"], target: string, over: Partial<ActivityStep> = {}) =>
    step({ tool: verb === "opened" ? "ocw_browser_open" : "ocw_browser_act", verb, target, ...over });
  const sam = { id: "01a11635-d6e7-7c87-9f17-b6b1dc048900", name: "Sam" };

  it("opened, read, clicked and typed read as the UI-SPEC verbs with the host as a host chip; never the typed text", () => {
    expect(text(row(b("opened", "panel.autofy.app")))).toMatch(/^Opened panel\.autofy\.app/);
    expect(text(row(b("read_page", "panel.autofy.app", { tool: "ocw_browser_snapshot" })))).toMatch(
      /^Read the page on panel\.autofy\.app/,
    );
    expect(text(row(b("clicked", "“Orders” on panel.autofy.app")))).toMatch(
      /^Clicked “Orders” on panel\.autofy\.app/,
    );
    const typed = row(b("typed", "“Search” on panel.autofy.app"));
    expect(text(typed)).toMatch(/^Typed into “Search” on panel\.autofy\.app/);
    expect(typed).toContain('data-testid="activity-host"');
    expect(typed).toContain('data-testid="activity-host-host"');
  });

  it("the sign-in step says 'you' to the requester and the requester's name to everyone else", () => {
    const s = b("asked_signin", "panel.autofy.app", { tool: "ocw_browser_signin" });
    const mine = html(
      <ol>
        <ActivityStepRow step={s} viewer={{ meId: sam.id, requester: sam }} />
      </ol>,
    );
    expect(text(mine)).toMatch(/^Asked you to sign in to panel\.autofy\.app/);
    const theirs = html(
      <ol>
        <ActivityStepRow step={s} viewer={{ meId: "someone-else", requester: sam }} />
      </ol>,
    );
    expect(text(theirs)).toMatch(/^Asked Sam to sign in to panel\.autofy\.app/);
  });

  it("a step under the requester's saved session carries the outline 'Signed in' badge", () => {
    const markup = row(b("clicked", "“Orders” on panel.autofy.app", { signedIn: true }));
    expect(markup).toContain('data-testid="activity-signed-in"');
    expect(text(markup)).toContain("Signed in");
    expect(row(b("clicked", "“Orders” on panel.autofy.app"))).not.toContain("activity-signed-in");
  });

  it("outcomes: Needs approval links the card; a blocked host and a reached cap read as the UI-SPEC sentences", () => {
    const waiting = row(
      b("clicked", "“Place order” on shop.fake.test", {
        signedIn: true,
        outcome: { kind: "approval", code: "approval_required", exitCode: null, durationMs: null },
        approvalMessageRoute:
          "/chat/dm/01a11635-d6e7-7c87-9f17-b6b1dc048941?m=01a11635-d6e7-7c87-9f17-b6b1dc048942",
      }),
    );
    expect(text(waiting)).toContain("Needs approval");
    expect(waiting).toMatch(
      /<a[^>]*href="\/chat\/dm\/01a11635-d6e7-7c87-9f17-b6b1dc048941\?m=01a11635-d6e7-7c87-9f17-b6b1dc048942"/,
    );
    // Never an outside link, whatever the step says.
    const outside = row(
      b("clicked", "“Pay” on shop.fake.test", {
        outcome: { kind: "approval", code: "approval_required", exitCode: null, durationMs: null },
        approvalMessageRoute: "//evil.example/x",
      }),
    );
    expect(outside).not.toContain("<a");

    const egress = row(
      b("blocked", "x.com", {
        tool: "ocw_browser_open",
        outcome: { kind: "blocked", code: "navigation_refused", exitCode: null, durationMs: null },
      }),
    );
    expect(text(egress)).toMatch(/^Blocked: x\.com isn't allowed by the network rules/);
    const cap = row(
      step({
        tool: "ocw_sandbox_exec",
        verb: "blocked",
        target: "ls",
        outcome: { kind: "blocked", code: "cap_reached", exitCode: null, durationMs: null },
        details: null,
      }),
    );
    expect(text(cap)).toMatch(/^Couldn't start the sandbox: the organization's limit is reached/);
    expect(text(cap)).toContain("Blocked");
  });
});

describe("live label (UI-SPEC Surface 5 › While the turn runs)", () => {
  it("'{bot} is {activity} · step {n}', from the server's phrase, else the last phrase, else the latest step", () => {
    const a = activity([step({ outcome: { kind: "ok", code: null, exitCode: null, durationMs: 3 } })], {
      running: true,
    });
    expect(liveLabel("Scout", livePhrase({ ...a, current: "writing reports/late.csv" }), 1)).toBe(
      "Scout is writing reports/late.csv · step 1",
    );
    expect(livePhrase(a, "running python fetch.py")).toBe("running python fetch.py");
    expect(livePhrase(a)).toBe("writing reports/late.csv");
    const markup = html(
      <BotActivityLive bot="Scout" phrase="clicking “Orders” on panel.autofy.app" step={4} />,
    );
    expect(text(markup)).toContain("Scout is clicking “Orders” on panel.autofy.app · step 4");
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('data-state="running"');
  });
});
