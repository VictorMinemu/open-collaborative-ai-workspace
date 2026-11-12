import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BOT_WORK_ZONE_LIMITS, DEFAULT_WORK_ZONE_POLICY, type WorkZonePolicyView } from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/lib/api";
import {
  BOT_FILE_MAX_COPY,
  BOT_SESSIONS_COPY,
  botFileMaxError,
  botSessionsError,
  PolicyForm,
  policyFieldError,
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

function render(
  view: WorkZonePolicyView,
  initial?: { botSessions?: string; botFileMax?: string; botFileMaxError?: string },
): string {
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
    expect(source).toMatch(/if \(noModes \|\| botError \|\|[^\n]*\) return;/);
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

/**
 * 07.17.1.1-09 (D-07, PD-11, PD-20): "Largest file a bot moves" under "Bot sessions at once", in MB (MiB, the chat's
 * `formatBytes`), at most the server's `OCW_ATTACHMENT_MAX_BYTES` (`serverFileMaxBytes`), saved in bytes.
 */
describe("Largest file a bot moves (07.17.1.1-09 Task 1)", () => {
  const MIB = 1024 * 1024;
  const GIB = 1024 * MIB;

  it("prefills from botFileMaxBytes, 25 MB for an organization that never saved", () => {
    expect(toDraft(policy()).botFileMaxMb).toBe(25);
    expect(toDraft(policy({ botFileMaxBytes: 41943040 })).botFileMaxMb).toBe(40);
    // A server ceiling below the stored value: the field shows what applies (the lower of the two wins anyway).
    expect(toDraft(policy({ botFileMaxBytes: 25 * MIB, serverFileMaxBytes: 10 * MIB })).botFileMaxMb).toBe(
      10,
    );
  });

  it.each([
    ["40", GIB, null],
    ["1", GIB, null],
    ["1024", GIB, null],
    ["0", GIB, "Enter a whole number from 1 to 1024."],
    ["1.5", GIB, "Enter a whole number from 1 to 1024."],
    ["abc", GIB, "Enter a whole number from 1 to 1024."],
    ["", GIB, "Enter a whole number from 1 to 1024."],
    ["1025", GIB, "Enter a whole number from 1 to 1024."],
    ["51", 50 * MIB, "Enter a whole number from 1 to 50."],
    ["50", 50 * MIB, null],
  ])("botFileMaxError(%s, %d)", (value, ceiling, error) => {
    expect(botFileMaxError(value, ceiling)).toBe(error);
    expect(BOT_FILE_MAX_COPY.invalid(7)).toBe("Enter a whole number from 1 to 7.");
  });

  it("Save sends botFileMaxBytes = MB × 1 048 576 when the API reports its ceiling, and nothing else new", () => {
    const view = policy({ botFileMaxBytes: 25 * MIB, serverFileMaxBytes: GIB });
    const draft = { ...toDraft(view), botFileMaxMb: 40 };
    const body = toPolicyBody(draft, { "claude-code": false, codex: false });
    expect(body.botFileMaxBytes).toBe(41943040);
    expect(body).not.toHaveProperty("botFileMaxMb");
    expect(body).not.toHaveProperty("serverFileMaxBytes");
    expect(body).toEqual({
      allowedPermissionModes: DEFAULT_WORK_ZONE_POLICY.allowedPermissionModes,
      allowFullAccess: false,
      allowedModels: { "claude-code": [], codex: [] },
      maxEffort: { "claude-code": null, codex: null },
      allowFastMode: false,
      runtimeUpdates: "automatic",
      botSessionsMax: 10,
      botFileMaxBytes: 41943040,
    });
    // An older API (no ceiling in the view) does not know the field: the body omits it.
    expect(toPolicyBody(toDraft(policy()), { "claude-code": false, codex: false })).not.toHaveProperty(
      "botFileMaxBytes",
    );
  });

  it("renders under Bot sessions at once: label tied to the input, the unit, the server's ceiling", () => {
    const html = render(policy({ botFileMaxBytes: 40 * MIB, serverFileMaxBytes: GIB }));
    const t = text(html);
    expect(t).toContain("Largest file a bot moves");
    expect(t).toContain(
      "Up to 1 GB on this server. Applies to files bots upload into or download from their Work Zone sessions.",
    );
    expect(t.indexOf("Bot sessions at once")).toBeLessThan(t.indexOf("Largest file a bot moves"));
    expect(t).toContain("How many Work Zone sessions bots may run at once, and the largest file they move.");
    expect(tagsOf(html, "bot-file-max")).toHaveLength(1);
    const input = tagsOf(html, "bot-file-max")[0] ?? "";
    expect(input).toContain('value="40"');
    expect(input).toContain('type="number"');
    expect(input).toContain('min="1"');
    expect(input).toContain('max="1024"');
    const id = input.match(/\sid="([^"]+)"/)?.[1] ?? "none";
    expect(html).toContain(`for="${id}"`);
    const described = input.match(/aria-describedby="([^"]+)"/)?.[1]?.split(" ") ?? [];
    expect(described).toContain(`${id}-unit`);
    expect(described).toContain(`${id}-hint`);
    expect(html).toMatch(new RegExp(`id="${id}-unit"[^>]*>MB<`));
    // 44 px on touch screens, full width on a phone.
    expect(input).toContain("max-lg:h-11");
    expect(input).toContain("w-full");
  });

  it("without serverFileMaxBytes (an older API) the hint drops the ceiling and validation uses 1 GiB", () => {
    const html = render(policy());
    const t = text(html);
    expect(t).not.toContain("on this server.");
    expect(t).toContain("Applies to files bots upload into or download from their Work Zone sessions.");
    expect(tagsOf(html, "bot-file-max")[0]).toContain('max="1024"');
  });

  it("an out-of-range value is shown under the field and Save is off", () => {
    const html = render(policy({ serverFileMaxBytes: 50 * MIB }), { botFileMax: "51" });
    expect(tagsOf(html, "bot-file-max")[0]).toContain('aria-invalid="true"');
    expect(text(html)).toContain("Enter a whole number from 1 to 50.");
    expect(tagsOf(html, "save-policy")[0]).toMatch(/\sdisabled=""/);
    // Changing only this field marks the form dirty.
    expect(text(html)).toContain("Unsaved changes");
  });

  it("the API's 400 for the field is shown under it", () => {
    const message = "Bots can move files up to 10 MB on this server";
    const refused = new ApiRequestError(400, "invalid_work_zone_policy", message, {
      field: "botFileMaxBytes",
    });
    expect(policyFieldError(refused)).toEqual({ field: "botFileMaxBytes", message });
    expect(policyFieldError(new ApiRequestError(500, "internal", "boom"))).toBeNull();
    const html = render(policy({ serverFileMaxBytes: GIB }), { botFileMaxError: message });
    expect(tagsOf(html, "bot-file-max")[0]).toContain('aria-invalid="true"');
    expect(text(html)).toContain(message);
  });

  it("dirty and reset follow the bot sessions field; the existing fields stay where they were", () => {
    const source = readFileSync(join(__dirname, "work-zone-policy-settings.tsx"), "utf8");
    expect(source).toContain("botFileMax.trim() !== String(saved.botFileMaxMb)");
    expect(source).toContain("setBotFileMax(String(saved.botFileMaxMb))");
    expect(source).toMatch(/if \(noModes \|\| botError \|\| fileError \|\|[^\n]*\) return;/);
    const html = render(policy({ serverFileMaxBytes: GIB }));
    expect(text(html)).toContain("All changes saved");
    expect(html.indexOf('data-testid="policy-bot-sessions"')).toBeLessThan(
      html.indexOf('data-testid="bot-file-max"'),
    );
  });
});
