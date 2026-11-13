import type { AgentCard, AgentCardTaskLink, BotTaskStopResponse } from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopTaskMutation } from "@/lib/task-queries";
import { AgentCardView } from "./agent-card";
import { TaskStopButton } from "./task-card";

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
