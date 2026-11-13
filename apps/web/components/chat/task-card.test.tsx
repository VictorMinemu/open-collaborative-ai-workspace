import type { AgentCard, AgentCardTaskLink, BotTaskStopResponse } from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopTaskMutation } from "@/lib/task-queries";
import { AgentCardView } from "./agent-card";
import { TaskStopButton, taskElapsedText, taskWaitText } from "./task-card";

/**
 * 07.17.1.1.2-10 (D-05, PD-11, PD-12, PD-20, PD-21): the live task card in chat. The server composes `card.task` from
 * the task row and offers `viewerCan.stop` to the people who may stop it; the web shows Stop from both (P3: it never
 * decides who may stop), calls `POST /api/v1/bot-tasks/:id/stop` once, never changes the card itself and turns
 * Stopped when the server announces it. Static markup in node, through the one card renderer (`AgentCardView`).
 */

const MESSAGE_ID = "01a11635-d6e7-7c87-9f17-b6b1dc048941";
const TASK_ID = "0b8f5c2e-3a41-4d7e-9c55-7f1e2d3c4b5a";
const SAM = "00000000-0000-4000-8000-0000000000f1";
const GOAL = "Read the knowledge pack and summarise it";

function link(over: Partial<AgentCardTaskLink> = {}): AgentCardTaskLink {
  return {
    taskId: TASK_ID,
    status: "running",
    outcome: null,
    turnsUsed: 1,
    maxTurns: 40,
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    deadlineAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
    finishedAt: null,
    requesterId: SAM,
    requesterName: "Sam Lee",
    waiting: null,
    wakeAt: null,
    ...over,
  };
}

function taskCard(over: Partial<AgentCard> = {}, task: Partial<AgentCardTaskLink> = {}): AgentCard {
  return {
    kind: "task",
    title: GOAL,
    fields: [
      { label: "Progress", value: "Read the first forty files of the pack" },
      { label: "Next step", value: "Read the next forty files of the pack" },
    ],
    status: "running",
    statusLabel: "Working",
    actions: [{ kind: "follow", label: "Follow" }],
    version: 2,
    decision: null,
    updatedAt: "2026-11-12T12:00:00.000Z",
    following: true,
    viewerCan: ["follow", "stop"],
    platformOwned: true,
    task: link(task),
    ...over,
  };
}

function render(card: AgentCard): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AgentCardView messageId={MESSAGE_ID} card={card} summary={card.title} authorName="Scout" />
    </QueryClientProvider>,
  );
}

const stopButton = (html: string) => /<button\b[^>]*data-testid="task-stop"[^>]*>/.exec(html)?.[0] ?? null;

describe("Stop on the task card (tracer, PD-12)", () => {
  it("an active task with viewerCan.stop shows Stop named after the goal, 44 px on phones", () => {
    const html = render(taskCard());
    expect(html).toContain('data-testid="agent-card"');
    expect(html).toContain('data-kind="task"');
    const button = stopButton(html);
    expect(button).not.toBeNull();
    expect(button).toContain(`aria-label="Stop task: ${GOAL}"`);
    expect(button).toContain("max-lg:h-11");
    expect(button).not.toMatch(/\sdisabled=""/);
  });

  it("no Stop without stop in viewerCan, and none once the task stopped (whatever a cache says)", () => {
    expect(stopButton(render(taskCard({ viewerCan: ["follow"] })))).toBeNull();
    expect(stopButton(render(taskCard({ viewerCan: undefined })))).toBeNull();
    const stopped = taskCard(
      { status: "cancelled", statusLabel: "Stopped" },
      { status: "stopped", outcome: "stopped_by_person", finishedAt: new Date().toISOString() },
    );
    expect(stopButton(render(stopped))).toBeNull();
    expect(stopButton(render(taskCard({}, { status: "waiting", waiting: "turn" })))).not.toBeNull();
  });

  it("while the stop is pending the button is disabled with a spinner", () => {
    const html = renderToStaticMarkup(<TaskStopButton goal={GOAL} pending onStop={() => {}} />);
    expect(html).toContain('data-testid="task-stop"');
    expect(html).toMatch(/<button\b[^>]*disabled=""/);
    expect(html).toContain("animate-spin");
    expect(html).toContain('aria-busy="true"');
    const idle = renderToStaticMarkup(<TaskStopButton goal={GOAL} pending={false} onStop={() => {}} />);
    expect(idle).not.toContain("animate-spin");
    expect(idle).not.toMatch(/<button\b[^>]*disabled=""/);
  });
});

describe("useStopTask's mutation: one POST, no optimistic update, the toast in the mutation (PD-12)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const run = async (answer: () => Response) => {
    const fetch = vi.fn(async () => answer());
    vi.stubGlobal("fetch", fetch);
    const client = new QueryClient();
    const said: Array<[string, string]> = [];
    const options = stopTaskMutation(TASK_ID, (tone, text) => said.push([tone, text]));
    const mutation = client.getMutationCache().build(client, options);
    await mutation.execute(undefined).catch(() => {});
    return { fetch, said, client, options };
  };

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("sends one POST to the task's stop route and says Stopped", async () => {
    const answer: BotTaskStopResponse = { ok: true, status: "stopped" };
    const { fetch, said, client, options } = await run(() => json(200, answer));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(new RegExp(`/api/v1/bot-tasks/${TASK_ID}/stop$`));
    expect(init.method).toBe("POST");
    expect(said).toEqual([["success", "Task stopped."]]);
    // No optimistic update: nothing is written to any cached card by the client.
    expect(options.onMutate).toBeUndefined();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });

  it("a task that had already ended says so", async () => {
    const { said } = await run(() => json(200, { ok: true, status: "done" }));
    expect(said).toEqual([["info", "This task had already finished."]]);
  });

  it("an error answer toasts the server's message and leaves every card as it was", async () => {
    const { said, client } = await run(() =>
      json(403, {
        error: {
          code: "not_task_owner",
          message: "Only the person this task runs for, a channel moderator or the bot's manager can stop it",
        },
      }),
    );
    expect(said).toEqual([
      ["error", "Only the person this task runs for, a channel moderator or the bot's manager can stop it"],
    ]);
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
});

/** The inner text of the element with `testId` (tags stripped), or null. */
function textOf(html: string, testId: string): string | null {
  const open = new RegExp(`<(\\w+)\\b[^>]*data-testid="${testId}"[^>]*>`).exec(html);
  if (!open) return null;
  const tag = open[1] ?? "div";
  const start = open.index + open[0].length;
  // Nested elements of the same tag: count opens and closes from the start.
  let depth = 1;
  const re = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, "g");
  re.lastIndex = start;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0)
      return html
        .slice(start, m.index)
        .replace(/<[^>]+>/g, "")
        .trim();
  }
  return null;
}

const tagOf = (html: string, testId: string) =>
  new RegExp(`<\\w+\\b[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? null;

describe("the task card's body (PD-20)", () => {
  const NOW = new Date("2026-11-12T15:00:00.000Z");
  const MIN = 60_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  const waiting = (over: Partial<AgentCardTaskLink> = {}) =>
    taskCard(
      { statusLabel: "Waiting" },
      {
        status: "waiting",
        waiting: "process",
        turnsUsed: 7,
        maxTurns: 40,
        startedAt: new Date(NOW.getTime() - 72 * MIN).toISOString(),
        ...over,
      },
    );

  it("a waiting task at turn 7 of 40, 72 minutes in: the pill, the meter and the elapsed time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const html = render(waiting());
    // The pill is the only live region of the card.
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).not.toContain("aria-live");
    expect(html).toContain('aria-label="Status: Waiting"');
    const meter = tagOf(html, "task-turns");
    expect(meter).toContain('role="progressbar"');
    expect(meter).toContain('aria-valuenow="7"');
    expect(meter).toContain('aria-valuemin="0"');
    expect(meter).toContain('aria-valuemax="40"');
    expect(meter).toContain('aria-valuetext="Turn 7 of 40"');
    expect(textOf(html, "task-turns")).toBe("Turn 7 of 40");
    expect(textOf(html, "task-elapsed")).toBe("Elapsed 1 h 12 min");

    // Re-read every 30 s: the text changes only once the minute does.
    vi.advanceTimersByTime(30_000);
    expect(textOf(render(waiting()), "task-elapsed")).toBe("Elapsed 1 h 12 min");
    vi.advanceTimersByTime(30_000);
    expect(textOf(render(waiting()), "task-elapsed")).toBe("Elapsed 1 h 13 min");
  });

  it("elapsed in words, and frozen at the end of an ended task", () => {
    const at = NOW.getTime();
    expect(taskElapsedText(at - 20_000, at)).toBe("Elapsed under a minute");
    expect(taskElapsedText(at - 5 * MIN, at)).toBe("Elapsed 5 min");
    expect(taskElapsedText(at - 120 * MIN, at)).toBe("Elapsed 2 h");
    expect(taskElapsedText(at - 72 * MIN - 59_000, at)).toBe("Elapsed 1 h 12 min");
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const done = taskCard(
      { status: "succeeded", statusLabel: "Done" },
      {
        status: "done",
        outcome: "done",
        startedAt: new Date(at - 300 * MIN).toISOString(),
        finishedAt: new Date(at - 290 * MIN).toISOString(),
      },
    );
    expect(textOf(render(done), "task-elapsed")).toBe("Elapsed 10 min");
  });

  it("the wait line: a background command, a Work Zone session, a timer; none while it works", () => {
    expect(textOf(render(waiting()), "task-waiting")).toBe("Waiting for a background command");
    expect(textOf(render(waiting({ waiting: "session" })), "task-waiting")).toBe(
      "Waiting for a Work Zone session",
    );
    const wakeAt = new Date(NOW.getTime() + 65 * MIN);
    const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(wakeAt);
    const timer = {
      ...link(),
      status: "waiting" as const,
      waiting: "timer" as const,
      wakeAt: wakeAt.toISOString(),
    };
    expect(taskWaitText(timer, NOW.getTime())).toBe(`Waiting until ${time}`);
    expect(
      textOf(render(waiting({ waiting: "timer", wakeAt: wakeAt.toISOString() })), "task-waiting"),
    ).toContain("Waiting until");
    expect(tagOf(render(taskCard()), "task-waiting")).toBeNull();
    expect(tagOf(render(waiting({ waiting: "turn" })), "task-waiting")).toBeNull();
  });

  it("the last progress and the next step, never in the generic field list", () => {
    const html = render(waiting());
    expect(textOf(html, "task-progress")).toBe("Read the first forty files of the pack");
    expect(textOf(html, "task-next")).toBe("Read the next forty files of the pack");
    expect(html).not.toContain('data-testid="agent-card-fields"');
    const bare = render(taskCard({ fields: [] }));
    expect(tagOf(bare, "task-progress")).toBeNull();
    expect(tagOf(bare, "task-next")).toBeNull();
  });

  it("ended tasks: Done, Blocked, Stopped with its notice; never Stop", () => {
    const ended = (
      status: "done" | "failed" | "stopped",
      outcome: AgentCardTaskLink["outcome"],
      extra = {},
    ) =>
      render(
        taskCard(
          { viewerCan: ["follow", "stop"], ...extra },
          { status, outcome, finishedAt: NOW.toISOString() },
        ),
      );
    const done = ended("done", "done");
    expect(done).toContain('aria-label="Status: Done"');
    expect(stopButton(done)).toBeNull();
    expect(ended("failed", "blocked")).toContain('aria-label="Status: Blocked"');
    expect(ended("failed", "error")).toContain('aria-label="Status: Failed"');
    const stopped = ended("stopped", "stopped_by_person", {
      notices: [{ tone: "neutral", text: "Stopped by Ana." }],
    });
    expect(stopped).toContain('aria-label="Status: Stopped"');
    expect(stopped).toContain("Stopped by Ana.");
    expect(stopButton(stopped)).toBeNull();
  });

  it("an ended task keeps its last progress note but hides the next step (there is none any more)", () => {
    for (const [status, outcome] of [
      ["done", "done"],
      ["failed", "blocked"],
      ["stopped", "budget_turns"],
      ["failed", "error"],
    ] as const) {
      const html = render(taskCard({}, { status, outcome, finishedAt: NOW.toISOString() }));
      expect(textOf(html, "task-progress")).toBe("Read the first forty files of the pack");
      expect(tagOf(html, "task-next")).toBeNull();
      expect(html).not.toContain("Next step");
    }
    // While it runs or waits, the next step stays.
    expect(textOf(render(taskCard()), "task-next")).toBe("Read the next forty files of the pack");
    expect(textOf(render(waiting()), "task-next")).toBe("Read the next forty files of the pack");
  });

  it("a long goal wraps, nothing scrolls sideways, and the body uses foreground text only", () => {
    const goal = `Migrate ${"every-service-in-the-billing-monorepo-".repeat(4)}to the new queue`;
    const html = render(taskCard({ title: goal }));
    expect(tagOf(html, "agent-card-title")).toContain("break-words");
    const body = tagOf(html, "task-body");
    expect(body).toContain("min-w-0");
    expect(textOf(html, "task-body")).not.toBeNull();
    const inner = html.slice(html.indexOf('data-testid="task-body"'));
    const section = inner.slice(0, inner.indexOf('data-testid="agent-card-actions"'));
    expect(section).not.toContain("text-muted-foreground");
    expect(section).not.toMatch(/text-foreground\/\d/);
    expect(section).not.toMatch(/\bopacity-\d/);
    expect(stopButton(html)).toContain(`aria-label="Stop task: ${goal}"`);
  });
});

describe("older payloads (PD-21)", () => {
  it("a task card without card.task renders as a generic card: title, fields and the server's pill", () => {
    const { task: _task, ...older } = taskCard({ viewerCan: ["follow"] });
    const html = render(older);
    expect(html).toContain('data-kind="task"');
    expect(html).toContain(`>${GOAL}<`);
    expect(html).toContain('data-testid="agent-card-fields"');
    expect(html).toContain('aria-label="Status: Working"');
    expect(tagOf(html, "task-turns")).toBeNull();
    expect(stopButton(html)).toBeNull();
  });
});
