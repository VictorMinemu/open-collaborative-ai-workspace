import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BOT_WORK_ZONE_LIMITS, DEFAULT_WORK_ZONE_POLICY, type WorkZonePolicyView } from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BOT_SESSIONS_COPY,
  botSessionsError,
  PolicyForm,
  toDraft,
  toPolicyBody,
} from "./work-zone-policy-settings";

/**
 * Settings › Work Zone policy › Bots (07.16-13, D-15, PD-22): "Bot sessions at once", saved with the rest of the
 * policy in the existing Save. The API stores, audits and enforces it; the page only refuses what the API would refuse
 * (outside 0..1000) before sending. Static markup in node plus the pure helpers the form uses.
 */

const T = "2026-11-09T09:00:00.000Z";

function policy(over: Partial<WorkZonePolicyView> = {}): WorkZonePolicyView {
  return {
    ...structuredClone(DEFAULT_WORK_ZONE_POLICY),
    updatedAt: T,
    knownModels: { "claude-code": [], codex: [] },
    ...over,
  };
}

function render(view: WorkZonePolicyView, initial?: { botSessions?: string }): string {
  const qc = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <PolicyForm policy={view} initial={initial} />
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

describe("Bot sessions at once (Task 3)", () => {
  it("shows the stored value, with the hint", () => {
    const html = render(policy({ botSessionsMax: 25 }));
    expect(text(html)).toContain(BOT_SESSIONS_COPY.label);
    expect(BOT_SESSIONS_COPY.label).toBe("Bot sessions at once");
    expect(text(html)).toContain("0 = bots never start Work Zone sessions");
    const input = tagsOf(html, "policy-bot-sessions")[0] ?? "";
    expect(input).toContain('value="25"');
    expect(input).toContain('type="number"');
    expect(input).toContain('min="0"');
    expect(input).toContain('max="1000"');
  });

  it("shows 10 when the policy has no value yet", () => {
    const html = render(policy({ botSessionsMax: undefined }));
    expect(tagsOf(html, "policy-bot-sessions")[0]).toContain(
      `value="${BOT_WORK_ZONE_LIMITS.orgSessionsDefault}"`,
    );
    expect(BOT_WORK_ZONE_LIMITS.orgSessionsDefault).toBe(10);
    expect(toDraft(policy({ botSessionsMax: undefined })).botSessionsMax).toBe(10);
  });

  it.each([
    ["0", null],
    ["10", null],
    ["1000", null],
    ["1001", "Enter a whole number from 0 to 1000"],
    ["-1", "Enter a whole number from 0 to 1000"],
    ["2.5", "Enter a whole number from 0 to 1000"],
    ["", "Enter a whole number from 0 to 1000"],
    ["abc", "Enter a whole number from 0 to 1000"],
  ])("refuses values outside 0..1000 before saving: %s", (value, error) => {
    expect(botSessionsError(value)).toBe(error);
  });

  it("an out-of-range value is shown inline and Save is off", () => {
    const html = render(policy({ botSessionsMax: 10 }), { botSessions: "1001" });
    expect(tagsOf(html, "policy-bot-sessions")[0]).toContain('aria-invalid="true"');
    expect(text(html)).toContain("Enter a whole number from 0 to 1000");
    expect(tagsOf(html, "save-policy")[0]).toMatch(/\sdisabled=""/);
  });

  it("is saved with the rest of the draft", () => {
    const draft = { ...toDraft(policy({ botSessionsMax: 10 })), botSessionsMax: 0 };
    const body = toPolicyBody(draft, { "claude-code": false, codex: false });
    expect(body).toEqual({
      allowedPermissionModes: DEFAULT_WORK_ZONE_POLICY.allowedPermissionModes,
      allowFullAccess: false,
      allowedModels: { "claude-code": [], codex: [] },
      maxEffort: { "claude-code": null, codex: null },
      allowFastMode: false,
      runtimeUpdates: "automatic",
      botSessionsMax: 0,
    });
    // The form's Save sends exactly that body, and refuses an invalid value first.
    const source = readFileSync(join(__dirname, "work-zone-policy-settings.tsx"), "utf8");
    expect(source).toContain("save.mutateAsync(toPolicyBody(draft, restrict))");
    expect(source).toMatch(/if \(noModes \|\| botError[^)]*\) return;/);
  });

  it("keeps the existing sections in place, the new one after Runtime updates", () => {
    const html = render(policy());
    const titles = [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1]);
    expect(titles).toEqual([
      "Permission modes",
      "Full access",
      "Models",
      "Maximum effort",
      "Fast mode",
      "Runtime updates",
      "Bots",
    ]);
  });

  it("is a 44 px field on touch screens and full width on a phone", () => {
    const input = tagsOf(render(policy()), "policy-bot-sessions")[0] ?? "";
    expect(input).toContain("max-lg:h-11");
    expect(input).toContain("w-full");
  });
});
