import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BotPolicyView, DEFAULT_BOT_POLICY } from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PolicyForm, TASK_FIELDS, taskLimitError, toDraft, toPolicyBody } from "./bot-policy-settings";

/**
 * Settings › Bot policy › Long tasks (07.17.1.1.2-04, D-04, PD-20): the "Long tasks" capability row with its personal
 * sub-switch, and the three limits saved as a partial `tasks` in the existing Save. The API stores, audits and enforces
 * them; the page only refuses what the API would refuse before sending. Static markup in node plus the pure helpers.
 */

function policy(over: Partial<BotPolicyView> = {}): BotPolicyView {
  return {
    ...structuredClone(DEFAULT_BOT_POLICY),
    updatedAt: null,
    availableSearchProviders: ["duckduckgo"],
    ...over,
  };
}

function render(view: BotPolicyView, initial?: Partial<BotPolicyView["tasks"]>): string {
  const qc = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <PolicyForm policy={view} initialTasks={initial} />
    </QueryClientProvider>,
  );
}

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const tagsOf = (html: string, id: string) =>
  html.match(new RegExp(`<[a-z]+[^>]*data-testid="${id}"[^>]*>`, "g")) ?? [];

/** The `<label>` naming an input, by the input's `id`. */
const labelFor = (html: string, inputTag: string) => {
  const id = inputTag.match(/\sid="([^"]+)"/)?.[1];
  if (!id) return null;
  const m = html.match(
    new RegExp(`<label[^>]*for="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([^<]*)</label>`),
  );
  return m?.[1] ?? null;
};

const ROW = (name: string) => `data-testid="policy-row-${name}"`;

describe("the Long tasks capability row", () => {
  it("lists Long tasks after the existing rows, which keep their order and test ids", () => {
    const html = render(policy());
    const order = ["internet", "memory", "dateTime", "replyModeAll", "longTasks"].map((n) =>
      html.indexOf(ROW(n)),
    );
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('data-testid="policy-replyModeAll-personal-na"');
    const row = html.slice(order[4], html.indexOf("</li>", order[4]));
    expect(text(row)).toContain("Long tasks");
    expect(text(row)).toContain("Bots keep working on long requests by themselves, within the limits below");
  });

  it("has accessible organization-wide and personal switches, both on by default", () => {
    const html = render(policy());
    const orgWide = tagsOf(html, "policy-longTasks-orgWide")[0] ?? "";
    const personal = tagsOf(html, "policy-longTasks-personal")[0] ?? "";
    expect(orgWide).toContain('aria-label="Long tasks: all bots"');
    expect(personal).toContain('aria-label="Long tasks: personal bots"');
    expect(orgWide).toContain('aria-checked="true"');
    expect(personal).toContain('aria-checked="true"');
  });

  it("the personal switch follows the organization's: off and disabled while all bots are off", () => {
    const html = render(
      policy({
        capabilities: { ...DEFAULT_BOT_POLICY.capabilities, longTasks: { orgWide: false, personal: true } },
      }),
    );
    const personal = tagsOf(html, "policy-longTasks-personal")[0] ?? "";
    expect(personal).toContain('aria-checked="false"');
    expect(personal).toContain('aria-disabled="true"');
  });
});

describe("the Long tasks limits", () => {
  it("shows the three fields with the defaults, each label tied to its input", () => {
    const html = render(policy());
    const fields = [
      ["policy-task-max-turns", "Turns per task", "40", "1", "200"],
      ["policy-task-max-hours", "Hours per task", "8", "1", "24"],
      ["policy-task-max-running", "Tasks running at once", "10", "0", "100"],
    ] as const;
    for (const [id, label, value, min, max] of fields) {
      const input = tagsOf(html, id)[0] ?? "";
      expect(input, id).toContain(`value="${value}"`);
      expect(input, id).toContain('type="number"');
      expect(input, id).toContain(`min="${min}"`);
      expect(input, id).toContain(`max="${max}"`);
      expect(labelFor(html, input), id).toBe(label);
    }
    expect(text(html)).toContain("At 0 no new task starts; running ones go on");
    expect(TASK_FIELDS.map((f) => f.testId)).toEqual(fields.map((f) => f[0]));
  });

  it("sits in its own section right after the capabilities and before web search", () => {
    const html = render(policy());
    const section = html.indexOf(">Long tasks</h2>");
    expect(section).toBeGreaterThan(html.indexOf(ROW("longTasks")));
    expect(section).toBeGreaterThan(html.indexOf(">Capabilities</h2>"));
    expect(section).toBeLessThan(html.indexOf(">Web search</h2>"));
  });

  it.each([
    [1, 1, 200, null],
    [200, 1, 200, null],
    [0, 0, 100, null],
    [201, 1, 200, "Enter a whole number from 1 to 200."],
    [0, 1, 24, "Enter a whole number from 1 to 24."],
    [25, 1, 24, "Enter a whole number from 1 to 24."],
    [1.5, 1, 200, "Enter a whole number from 1 to 200."],
    [-1, 0, 100, "Enter a whole number from 0 to 100."],
    [Number.NaN, 0, 100, "Enter a whole number from 0 to 100."],
  ])("taskLimitError(%s, %s, %s)", (value, min, max, error) => {
    expect(taskLimitError(value, min, max)).toBe(error);
  });

  it("201 turns shows the error inline and turns Save off", () => {
    const html = render(policy(), { maxTurns: 201 });
    const input = tagsOf(html, "policy-task-max-turns")[0] ?? "";
    expect(input).toContain('aria-invalid="true"');
    expect(text(html)).toContain("Enter a whole number from 1 to 200.");
    expect(tagsOf(html, "bot-policy-save")[0]).toMatch(/\sdisabled=""/);
  });

  it("0 tasks running at once is accepted, with its hint, and Save stays on", () => {
    const html = render(policy(), { maxRunning: 0 });
    expect(tagsOf(html, "policy-task-max-running")[0]).toContain('aria-invalid="false"');
    expect(text(html)).toContain("At 0 no new task starts; running ones go on");
    expect(text(html)).not.toContain("Enter a whole number");
    expect(tagsOf(html, "bot-policy-save")[0]).not.toMatch(/\sdisabled=""/);
  });

  it("Save sends only what changed: one limit becomes { tasks: { maxTurns: 12 } }", () => {
    const saved = toDraft(policy());
    const draft = { ...saved, tasks: { ...saved.tasks, maxTurns: 12 } };
    expect(toPolicyBody(draft, saved, false)).toEqual({ tasks: { maxTurns: 12 } });
    const both = {
      ...draft,
      capabilities: { ...draft.capabilities, longTasks: { orgWide: false, personal: true } },
    };
    expect(toPolicyBody(both, saved, false)).toEqual({
      capabilities: { longTasks: { orgWide: false, personal: true } },
      tasks: { maxTurns: 12 },
    });
    expect(toPolicyBody(saved, saved, false)).toEqual({});
    // Allowing every model again sends the empty list, as before.
    const restricted = { ...saved, personalAllowedModels: ["mock/mock-1"] };
    expect(toPolicyBody(restricted, restricted, false)).toEqual({ personalAllowedModels: [] });
    // The form's Save sends exactly that body.
    const source = readFileSync(join(__dirname, "bot-policy-settings.tsx"), "utf8");
    expect(source).toContain("save.mutateAsync(toPolicyBody(draft, saved, restrictModels))");
  });
});
