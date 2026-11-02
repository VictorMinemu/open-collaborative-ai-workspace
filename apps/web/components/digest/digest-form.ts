import {
  type AiModelOption,
  AutomationTimeZone,
  ClockTime,
  DigestSection,
  type DigestSettings,
  type DigestView,
  type ModelRef,
  Weekday,
} from "@ocw/contracts";

/**
 * The digest form (07.6-16, AUTO-05; D-05, D-07; UI-SPEC Surface 6, R6) as plain data: what a first digest starts
 * with, the field rules (the same ones the API's `DigestSettings` enforces, said in the spec's words), whether there
 * is something to save, and who pays for the optional summary. The page renders it; the API decides everything else.
 */

export const DIGEST_COPY = {
  title: "Digest",
  description: "A short message with what needs you, on the days you choose",
  master: "Send me a digest",
  off: "Off. Nothing is sent.",
  when: "When",
  days: "Days",
  weekdays: "Weekdays",
  everyDay: "Every day",
  at: "At",
  timeZone: "Time zone",
  detected: "Detected from this browser.",
  include: "What to include",
  skipEmpty: "Skip it when there's nothing new",
  deliverWith: "Deliver with",
  deliverHint: "It arrives in your direct messages with the bot.",
  noBot: "You need a bot to deliver it.",
  createBot: "Create a personal bot",
  aiSummary: "AI summary",
  addSummary: "Add a short summary on top",
  model: "Model",
  noModels: "You have no AI chat models to write it.",
  preview: "Preview",
  test: "Send a test now",
  save: "Save digest",
  saveFirst: "Save first.",
  previewEmpty: "Nothing new right now. With “Skip it when there's nothing new” on, no digest would be sent.",
  previewError: "Couldn't build a preview. Try again.",
  loadError: "Couldn't load your digest.",
  saved: (next: string) => `Digest saved. Next one ${next}.`,
  turnedOff: "Digest turned off.",
  sent: (bot: string) => `Sent to your DM with ${bot}.`,
  open: "Open",
  meteredNotice:
    "Each summary is one AI request billed to the organization and counts against your AI chat limits. The list itself is never written by AI.",
  planNotice: "Each summary is one AI request on your ChatGPT plan. The list itself is never written by AI.",
  errors: {
    days: "Pick at least one day",
    time: "Enter a time",
    timeZone: "Pick a time zone from the list",
    sections: "Pick at least one",
    bot: "Pick a bot to deliver it.",
  },
} as const;

export const WEEKDAYS: readonly Weekday[] = Weekday.options;
export const WORK_WEEK: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri"];

export const DAY_LABELS: Record<Weekday, { short: string; letter: string; full: string }> = {
  mon: { short: "Mon", letter: "M", full: "Monday" },
  tue: { short: "Tue", letter: "T", full: "Tuesday" },
  wed: { short: "Wed", letter: "W", full: "Wednesday" },
  thu: { short: "Thu", letter: "T", full: "Thursday" },
  fri: { short: "Fri", letter: "F", full: "Friday" },
  sat: { short: "Sat", letter: "S", full: "Saturday" },
  sun: { short: "Sun", letter: "S", full: "Sunday" },
};

export const SECTIONS: ReadonlyArray<{ id: DigestSection; label: string; hint: string }> = [
  { id: "decisions", label: "Decisions waiting for you", hint: "Approvals and proposals" },
  { id: "follows", label: "Cards you follow", hint: "Updated since the last digest" },
  { id: "mentions", label: "Unread mentions", hint: "Mentions, replies and DMs" },
  { id: "work_zone", label: "Work Zone sessions", hint: "Waiting for approval or ended" },
];

export interface DigestForm {
  enabled: boolean;
  days: Weekday[];
  time: string;
  timeZone: string;
  /** The zone is still the browser's own (hint "Detected from this browser." until it is changed). */
  zoneDetected: boolean;
  sections: DigestSection[];
  skipEmpty: boolean;
  agentId: string | null;
  summary: { enabled: boolean; modelRef: ModelRef | null };
}

export type DigestErrors = Partial<Record<"days" | "time" | "timeZone" | "sections" | "bot", string>>;

const DEFAULT_TIME = "09:00";

/** The browser's IANA zone (UTC when the engine does not say). */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The saved digest, or a first one: off, weekdays, the browser's zone, every section, the first (personal) bot. */
export function formFromView(view: Pick<DigestView, "settings" | "bots">, browserZone: string): DigestForm {
  const s = view.settings;
  if (s) {
    return {
      enabled: s.enabled,
      days: inWeekOrder(s.days),
      time: s.time,
      timeZone: s.timeZone,
      zoneDetected: false,
      sections: inSectionOrder(s.sections),
      skipEmpty: s.skipEmpty,
      agentId: s.agentId,
      summary: { enabled: s.summary.enabled, modelRef: s.summary.modelRef },
    };
  }
  return {
    enabled: false,
    days: [...WORK_WEEK],
    time: DEFAULT_TIME,
    timeZone: browserZone,
    zoneDetected: true,
    sections: [...DigestSection.options],
    skipEmpty: true,
    // The API lists personal bots first: the only personal bot, or the first one, is preselected.
    agentId: view.bots[0]?.id ?? null,
    // Never on by default (T-07.6-16-01).
    summary: { enabled: false, modelRef: null },
  };
}

export const inWeekOrder = (days: readonly Weekday[]): Weekday[] => WEEKDAYS.filter((d) => days.includes(d));
const inSectionOrder = (sections: readonly DigestSection[]): DigestSection[] =>
  DigestSection.options.filter((s) => sections.includes(s));

export function validateDigest(form: DigestForm, bots: DigestView["bots"]): DigestErrors {
  const errors: DigestErrors = {};
  if (form.days.length === 0) errors.days = DIGEST_COPY.errors.days;
  if (!ClockTime.safeParse(form.time).success) errors.time = DIGEST_COPY.errors.time;
  // The API's own rule (`isKnownTimeZone` behind `AutomationTimeZone`), so a zone accepted here saves.
  if (!AutomationTimeZone.safeParse(form.timeZone.trim()).success)
    errors.timeZone = DIGEST_COPY.errors.timeZone;
  if (form.sections.length === 0) errors.sections = DIGEST_COPY.errors.sections;
  if (!form.agentId || !bots.some((b) => b.id === form.agentId)) errors.bot = DIGEST_COPY.errors.bot;
  return errors;
}

/** The settings the API receives (`PUT /digest`, `POST /digest/preview`); call only with a valid form. */
export function toSettings(form: DigestForm): DigestSettings {
  return {
    enabled: form.enabled,
    days: inWeekOrder(form.days),
    time: form.time,
    timeZone: form.timeZone.trim(),
    sections: inSectionOrder(form.sections),
    skipEmpty: form.skipEmpty,
    agentId: form.agentId ?? "",
    summary: { enabled: form.summary.enabled, modelRef: form.summary.enabled ? form.summary.modelRef : null },
  };
}

const canonical = (s: DigestSettings) =>
  JSON.stringify({
    ...s,
    days: inWeekOrder(s.days),
    sections: inSectionOrder(s.sections),
    summary: { enabled: s.summary.enabled, modelRef: s.summary.enabled ? s.summary.modelRef : null },
  });

/** Something to save: never saved yet, or any field differs from the saved digest. */
export function isDirty(form: DigestForm, view: Pick<DigestView, "settings">): boolean {
  if (!view.settings) return true;
  return canonical(toSettings(form)) !== canonical(view.settings);
}

/** Why Save is disabled: null = enabled, "" = nothing to say (no change, or a field shows its own error). */
export function saveBlocker(errors: DigestErrors, dirty: boolean): string | null {
  if (errors.bot) return errors.bot;
  if (Object.keys(errors).length > 0 || !dirty) return "";
  return null;
}

/** Send a test now uses the saved digest only: disabled with "Save first." until it is saved and unchanged. */
export function testBlocker(view: Pick<DigestView, "settings">, dirty: boolean): string | null {
  return !view.settings || dirty ? DIGEST_COPY.saveFirst : null;
}

/** Who pays for the summary: the person's own ChatGPT plan, else the organization (its keys). */
export function summaryNotice(model: Pick<AiModelOption, "group"> | undefined): string {
  return model?.group === "chatgpt_plan" ? DIGEST_COPY.planNotice : DIGEST_COPY.meteredNotice;
}

/** `Mon, Oct 12, 8:00 AM` in the digest's zone (the time the person picked reads back as picked). */
export function formatNext(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: safeZone(timeZone),
  })
    .format(new Date(iso))
    .replace(/\u202f/g, " ");
}

/** `Oct 8` in the digest's zone. */
export function formatDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: safeZone(timeZone),
  }).format(new Date(iso));
}

const safeZone = (zone: string) => (AutomationTimeZone.safeParse(zone).success ? zone : "UTC");

/** The line under the master switch: `Next: …` (and ` · last sent …`) when on, the off sentence otherwise. */
export function statusLine(view: Pick<DigestView, "settings" | "nextRunAt" | "lastSentAt">): string {
  const s = view.settings;
  if (!s?.enabled || !view.nextRunAt) return DIGEST_COPY.off;
  const last = view.lastSentAt ? ` · last sent ${formatDay(view.lastSentAt, s.timeZone)}` : "";
  return `Next: ${formatNext(view.nextRunAt, s.timeZone)}${last}`;
}

let zoneList: string[] | null = null;
/** Every IANA zone the browser knows, for the zone field's `<datalist>`. */
export function timeZones(): string[] {
  if (zoneList) return zoneList;
  try {
    zoneList = Intl.supportedValuesOf("timeZone");
  } catch {
    zoneList = [];
  }
  if (!zoneList.includes("UTC")) zoneList = ["UTC", ...zoneList];
  return zoneList;
}
