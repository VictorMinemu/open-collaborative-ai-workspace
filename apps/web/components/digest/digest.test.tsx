import type { AiModelOption, DigestView } from "@ocw/contracts";
import { EventTypes } from "@ocw/contracts";
import type { TopicFrame } from "@ocw/realtime-client";
import { QueryClient } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { applyDigestFrame, digestKeys } from "@/lib/digest-queries";
import {
  DIGEST_COPY,
  type DigestForm,
  formFromView,
  isDirty,
  saveBlocker,
  saveRequest,
  shouldResync,
  summaryNotice,
  testBlocker,
  toSettings,
  validateDigest,
} from "./digest-form";
import { DigestPreview } from "./digest-preview";
import { DigestSettingsView, type DigestSettingsViewProps } from "./digest-settings";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => (
    <a href={href} {...(rest as object)}>
      {children as never}
    </a>
  ),
}));

/**
 * Settings › Digest (07.6-16, AUTO-05; D-05, D-07; UI-SPEC Surface 6, R6): the form rules (at least one day and one
 * section, a zone from the list, the summary off by default, who pays), the view's states as static markup, and the
 * user-stream handler. The API decides the bots, the next send time and every refusal; the page only shows them.
 */

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
/** Visible words only (tags stripped, entities of the copy decoded). */
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
/** The opening tag carrying `data-testid="<id>"`. */
const tagOf = (markup: string, id: string) => {
  const at = markup.indexOf(`data-testid="${id}"`);
  expect(at, `${id} is rendered`).toBeGreaterThan(-1);
  return markup.slice(markup.lastIndexOf("<", at), markup.indexOf(">", at) + 1);
};

const SCOUT = "01a11635-d6e7-7c87-9f17-0000000000a1";
const OPS = "01a11635-d6e7-7c87-9f17-0000000000a2";
const AUTOMATION = "01a11635-d6e7-7c87-9f17-0000000000b1";

const BOTS: DigestView["bots"] = [
  { id: SCOUT, displayName: "Scout", personal: true, unitName: null },
  { id: OPS, displayName: "Ops helper", personal: false, unitName: "Operations" },
];

const view = (over: Partial<DigestView> = {}): DigestView => ({
  settings: null,
  version: null,
  automationId: null,
  nextRunAt: null,
  lastSentAt: null,
  bots: BOTS,
  ...over,
});

const HAIKU = {
  ref: { backend: "org_key", provider: "anthropic", modelId: "claude-haiku-4-5" },
  label: "Claude Haiku 4.5",
  providerLabel: "Anthropic",
  group: "organization",
  metered: true,
  available: true,
  reason: null,
  isDefault: true,
} as unknown as AiModelOption;

const PLAN = {
  ...HAIKU,
  ref: { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-5.5" },
  label: "GPT-5.5",
  providerLabel: "ChatGPT",
  group: "chatgpt_plan",
  metered: false,
  isDefault: false,
} as unknown as AiModelOption;

const form = (over: Partial<DigestForm> = {}): DigestForm => ({
  ...formFromView(view(), "Europe/Madrid"),
  ...over,
});

const props = (over: Partial<DigestSettingsViewProps> = {}): DigestSettingsViewProps => ({
  form: form(),
  errors: {},
  view: view(),
  models: [HAIKU, PLAN],
  dirty: true,
  saving: false,
  testing: false,
  creatingBot: false,
  canCreateBot: true,
  preview: { state: "idle" },
  previewing: false,
  onChange: () => {},
  onZoneBlur: () => {},
  onPreview: () => {},
  onTest: () => {},
  onSave: () => {},
  onCreateBot: () => {},
  ...over,
});

describe("the digest form (R6)", () => {
  it("a first digest: off, weekdays, browser zone, every section, skip-empty, the personal bot, no summary", () => {
    const f = formFromView(view(), "Europe/Madrid");
    expect(f.enabled).toBe(false);
    expect(f.days).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(f.timeZone).toBe("Europe/Madrid");
    expect(f.zoneDetected).toBe(true);
    expect(f.sections).toEqual(["decisions", "follows", "mentions", "work_zone"]);
    expect(f.skipEmpty).toBe(true);
    expect(f.agentId).toBe(SCOUT);
    // The AI summary is never on by default (T-07.6-16-01).
    expect(f.summary).toEqual({ enabled: false, modelRef: null });
  });

  it("a saved digest comes back as saved, and the zone is no longer 'detected'", () => {
    const saved = {
      enabled: true,
      days: ["mon" as const, "fri" as const],
      time: "08:00",
      timeZone: "America/New_York",
      sections: ["mentions" as const],
      skipEmpty: false,
      agentId: OPS,
      summary: { enabled: true, modelRef: HAIKU.ref },
    };
    const f = formFromView(view({ settings: saved, automationId: AUTOMATION }), "Europe/Madrid");
    expect(f.zoneDetected).toBe(false);
    expect(toSettings(f)).toEqual(saved);
    expect(isDirty(f, view({ settings: saved }))).toBe(false);
    expect(isDirty({ ...f, days: ["fri", "mon"] }, view({ settings: saved }))).toBe(false);
    expect(isDirty({ ...f, time: "09:00" }, view({ settings: saved }))).toBe(true);
    // Never saved: always something to save.
    expect(isDirty(formFromView(view(), "UTC"), view())).toBe(true);
  });

  it("no day → 'Pick at least one day'; no section → 'Pick at least one'; a zone not in the list → its error", () => {
    expect(validateDigest(form(), BOTS)).toEqual({});
    expect(validateDigest(form({ days: [] }), BOTS).days).toBe("Pick at least one day");
    expect(validateDigest(form({ sections: [] }), BOTS).sections).toBe("Pick at least one");
    expect(validateDigest(form({ timeZone: "Europe/Atlantis" }), BOTS).timeZone).toBe(
      "Pick a time zone from the list",
    );
    expect(validateDigest(form({ time: "" }), BOTS).time).toBe("Enter a time");
    expect(validateDigest(form({ agentId: null }), []).bot).toBe("Pick a bot to deliver it.");
    // A bot that is no longer listed (deleted, no longer readable) is no choice at all.
    expect(validateDigest(form({ agentId: OPS }), BOTS.slice(0, 1)).bot).toBe("Pick a bot to deliver it.");
  });

  it("saves from the version the form was taken from; a newer digest refreshes only an untouched form (07.6 review C LO-06)", () => {
    const saved = toSettings(form());
    const base = { settings: saved, version: 3 };
    // The request carries the base version (null: no digest yet), never the latest one in the cache.
    expect(saveRequest(form({ time: "07:00" }), base)).toEqual({
      ...toSettings(form({ time: "07:00" })),
      expectedVersion: 3,
    });
    expect(saveRequest(form(), null).expectedVersion).toBeNull();
    // A pause from the automations list (version 4): an untouched form follows it...
    const paused = view({ settings: { ...saved, enabled: false }, version: 4 });
    expect(shouldResync(form(), base, paused)).toBe(true);
    // ...a form with unsaved changes keeps its base, so its save is a 409 instead of undoing the pause.
    expect(shouldResync(form({ time: "07:00" }), base, paused)).toBe(false);
    // The same digest at the same version: nothing to do; the first load always syncs.
    expect(shouldResync(form(), base, view({ settings: saved, version: 3 }))).toBe(false);
    expect(shouldResync(null, null, paused)).toBe(true);
  });

  it("Save needs a change and a valid form; Send a test now needs the saved digest ('Save first.')", () => {
    expect(saveBlocker({}, true)).toBeNull();
    expect(saveBlocker({}, false)).toBe("");
    expect(saveBlocker({ bot: "Pick a bot to deliver it." }, true)).toBe("Pick a bot to deliver it.");
    expect(saveBlocker({ days: "Pick at least one day" }, true)).toBe("");
    expect(testBlocker(view(), false)).toBe("Save first.");
    const saved = view({ settings: toSettings(form()), automationId: AUTOMATION });
    expect(testBlocker(saved, true)).toBe("Save first.");
    expect(testBlocker(saved, false)).toBeNull();
  });

  it("the notice names who pays: the organization for its keys, the person's own ChatGPT plan otherwise", () => {
    expect(summaryNotice(HAIKU)).toBe(
      "Each summary is one AI request billed to the organization and counts against your AI chat limits. The list itself is never written by AI.",
    );
    expect(summaryNotice(PLAN)).toBe(
      "Each summary is one AI request on your ChatGPT plan. The list itself is never written by AI.",
    );
    expect(summaryNotice(undefined)).toBe(summaryNotice(HAIKU));
  });
});

describe("<DigestSettingsView /> (UI-SPEC Surface 6)", () => {
  it("renders every block with the copy of the spec and the personal bot preselected", () => {
    const markup = html(<DigestSettingsView {...props()} />);
    const out = text(markup);
    for (const words of [
      "Send me a digest",
      DIGEST_COPY.off,
      "When",
      "Weekdays",
      "Every day",
      "Detected from this browser.",
      "What to include",
      "Decisions waiting for you",
      "Approvals and proposals",
      "Cards you follow",
      "Unread mentions",
      "Work Zone sessions",
      "Skip it when there's nothing new",
      "Deliver with",
      "Scout · your personal bot",
      "Ops helper · Operations",
      "It arrives in your direct messages with the bot.",
      "AI summary",
      "Add a short summary on top",
      "Preview",
      "Send a test now",
      "Save digest",
    ]) {
      expect(out, words).toContain(words);
    }
    expect(tagOf(markup, `digest-bot-${SCOUT}`)).toContain("checked");
    expect(tagOf(markup, `digest-bot-${OPS}`)).not.toContain("checked");
  });

  it("shows the next send and the last one when the digest is on", () => {
    const saved = toSettings(form({ enabled: true, time: "08:00" }));
    const out = text(
      html(
        <DigestSettingsView
          {...props({
            form: form({ enabled: true, time: "08:00" }),
            view: view({
              settings: saved,
              automationId: AUTOMATION,
              nextRunAt: "2026-10-12T06:00:00.000Z",
              lastSentAt: "2026-10-08T06:00:00.000Z",
            }),
            dirty: false,
          })}
        />,
      ),
    );
    expect(out).toContain("Next: Mon, Oct 12, 8:00 AM · last sent Oct 8");
  });

  it("the field errors are shown under their fields", () => {
    const out = text(
      html(
        <DigestSettingsView
          {...props({
            form: form({ days: [], sections: [], timeZone: "Nowhere/Land" }),
            errors: {
              days: "Pick at least one day",
              sections: "Pick at least one",
              timeZone: "Pick a time zone from the list",
            },
          })}
        />,
      ),
    );
    expect(out).toContain("Pick at least one day");
    expect(out).toContain("Pick at least one");
    expect(out).toContain("Pick a time zone from the list");
  });

  it("off greys the sections but keeps every field editable", () => {
    const markup = html(<DigestSettingsView {...props({ form: form({ enabled: false }) })} />);
    expect(markup).toContain('data-off="true"');
    // Nothing between the switch and the buttons is disabled while it is off.
    const from = markup.indexOf('data-testid="digest-when"');
    const to = markup.indexOf('data-testid="digest-actions"');
    expect(from).toBeGreaterThan(-1);
    expect(markup.slice(from, to)).not.toMatch(/\sdisabled=""/);
    const on = html(<DigestSettingsView {...props({ form: form({ enabled: true }) })} />);
    expect(on).not.toContain('data-off="true"');
  });

  it("the summary is off by default: no model select and no notice until it is turned on", () => {
    const off = html(<DigestSettingsView {...props()} />);
    expect(off).not.toContain('data-testid="digest-summary-model"');
    expect(text(off)).not.toContain("billed to the organization");
    const on = html(
      <DigestSettingsView {...props({ form: form({ summary: { enabled: true, modelRef: HAIKU.ref } }) })} />,
    );
    expect(on).toContain('data-testid="digest-summary-model"');
    expect(on).toContain("METERED");
    expect(text(on)).toContain(summaryNotice(HAIKU));
  });

  it("a ChatGPT plan model changes the notice to the person's plan", () => {
    const out = text(
      html(
        <DigestSettingsView {...props({ form: form({ summary: { enabled: true, modelRef: PLAN.ref } }) })} />,
      ),
    );
    expect(out).toContain("Each summary is one AI request on your ChatGPT plan.");
    expect(out).not.toContain("billed to the organization");
  });

  it("no bot: the dashed box with Create a personal bot, and Save explains why it is disabled", () => {
    const markup = html(
      <DigestSettingsView
        {...props({
          view: view({ bots: [] }),
          form: form({ agentId: null }),
          errors: { bot: "Pick a bot to deliver it." },
        })}
      />,
    );
    const out = text(markup);
    expect(markup).toContain('data-testid="digest-no-bot"');
    expect(out).toContain("You need a bot to deliver it.");
    expect(out).toContain("Create a personal bot");
    expect(out).toContain("Pick a bot to deliver it.");
    expect(tagOf(markup, "digest-save")).toContain('disabled=""');
  });

  it("without the right to create one, the dashed box only says a bot is needed", () => {
    const out = text(
      html(
        <DigestSettingsView
          {...props({ view: view({ bots: [] }), form: form({ agentId: null }), canCreateBot: false })}
        />,
      ),
    );
    expect(out).toContain("You need a bot to deliver it.");
    expect(out).not.toContain("Create a personal bot");
  });

  it("unsaved changes disable Send a test now with 'Save first.'", () => {
    const markup = html(<DigestSettingsView {...props({ dirty: true })} />);
    expect(text(markup)).toContain("Save first.");
    expect(tagOf(markup, "digest-test")).toContain('disabled=""');
  });
});

describe("<DigestPreview />", () => {
  it("renders the exact Markdown through the shared safe renderer", () => {
    const markup = html(
      <DigestPreview
        state={{
          state: "ready",
          markdown: "### Your digest · Oct 12\n\n**Waiting for you (1)**",
          empty: false,
        }}
      />,
    );
    expect(markup).toContain('data-testid="digest-preview"');
    expect(text(markup)).toContain("Your digest · Oct 12");
  });

  it("empty: the sentence about skip-empty; error: try again; idle: nothing", () => {
    expect(text(html(<DigestPreview state={{ state: "ready", markdown: "", empty: true }} />))).toContain(
      "Nothing new right now. With “Skip it when there's nothing new” on, no digest would be sent.",
    );
    expect(text(html(<DigestPreview state={{ state: "error" }} />))).toContain(
      "Couldn't build a preview. Try again.",
    );
    expect(html(<DigestPreview state={{ state: "idle" }} />)).toBe("");
  });
});

describe("live updates on the viewer's own user: stream", () => {
  it("automation and run updates (ev or eph) refetch the digest; anything else is ignored", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const frame = (op: string, type: string) =>
      ({ op, type, data: { automationId: AUTOMATION }, topic: "user:x", seq: 1 }) as unknown as TopicFrame;
    expect(applyDigestFrame(qc, frame("ev", EventTypes.automationUpdated))).toBe(true);
    expect(applyDigestFrame(qc, frame("eph", EventTypes.automationRunUpdated))).toBe(true);
    expect(applyDigestFrame(qc, frame("ev", EventTypes.notificationCreated))).toBe(false);
    expect(applyDigestFrame(qc, frame("ack", EventTypes.automationUpdated))).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith({ queryKey: digestKeys.view });
  });
});
