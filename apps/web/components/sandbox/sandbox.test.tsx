import type { SandboxStatusView } from "@ocw/contracts";
import { FileText, Folder } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TreeRowView } from "@/components/common/tree-row";
import { QuotaMeter, quotaTone } from "./quota-meter";
import { presentState, SandboxStatusCard } from "./sandbox-status-card";
import { sandboxTabVisible } from "./sandbox-tab";
import { checkFiles } from "./upload-dialog";

/**
 * The Sandbox tab's building blocks as static markup (07.8-15; UI-SPEC §3.1, R4): the shared tree row, the status card
 * in every state with its fixed copy, the quota meter's thresholds, when the page shows the tab, and the upload
 * dialog's per-file checks. Rendered in node, no DOM.
 */

const decode = (s: string) =>
  s
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

const MIB = 1024 * 1024;

const status = (over: Partial<SandboxStatusView> = {}): SandboxStatusView => ({
  agentId: "00000000-0000-4000-8000-000000000001",
  state: "running",
  runtime: "gvisor",
  lastActiveAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  diskBytes: 1_503_238_554,
  diskQuotaBytes: 2048 * MIB,
  cpuMsToday: 12 * 60_000,
  org: { cpuMinutesToday: 140, cpuMinutesPerDay: 600 },
  limits: { cpus: 1, memoryBytes: 1024 * MIB, pids: 256, idleStopMinutes: 15 },
  packages: 2,
  teamBot: false,
  stopReason: null,
  viewerCan: { files: true, control: true },
  ...over,
});

const card = (over: Partial<SandboxStatusView> = {}, actions: "inline" | "row" = "inline") =>
  decode(
    renderToStaticMarkup(
      <SandboxStatusCard
        status={status(over)}
        bot="Scout"
        actions={actions}
        onStop={() => {}}
        onRestart={() => {}}
      />,
    ),
  );

describe("TreeRowView", () => {
  const row = (over: Partial<Parameters<typeof TreeRowView>[0]> = {}) =>
    renderToStaticMarkup(
      <TreeRowView
        level={1}
        folder={false}
        expanded={false}
        selected={false}
        tabStop={false}
        stacked={false}
        label="q3.csv, 35 B"
        icon={FileText}
        {...over}
      >
        <span>q3.csv</span>
      </TreeRowView>,
    );

  it("draws the 07.2 row: h-8 on desktop, the inset focus ring, one guide per level and no chevron for a file", () => {
    const out = row();
    expect(out).toContain('role="treeitem"');
    expect(out).toContain('aria-label="q3.csv, 35 B"');
    expect(out).toContain('tabindex="-1"');
    expect(out).toContain("h-8");
    expect(out).toContain("focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset");
    expect(out).toContain("lg:hover:bg-sidebar-accent/60");
    expect(out.match(/absolute inset-y-0 w-px bg-border/g)).toHaveLength(1);
    expect(out).toContain("padding-left:20px");
    expect(out).not.toContain("rotate-90");
  });

  it("marks the selected row with the accent background, the 2 px primary bar and aria-current", () => {
    const out = row({ selected: true, current: true, tabStop: true });
    expect(out).toContain("bg-sidebar-accent font-semibold text-sidebar-accent-foreground");
    expect(out).toContain("w-0.5 rounded-r-full bg-primary");
    expect(out).toContain('aria-current="page"');
    expect(out).toContain('tabindex="0"');
    expect(out).toContain("text-primary");
  });

  it("gives folders a chevron (turned when open) and phones 44 px rows with a 24 px box", () => {
    const open = row({ folder: true, expanded: true, icon: Folder, stacked: true, label: "reports, folder" });
    expect(open).toContain("rotate-90");
    expect(open).toContain("h-11");
    expect(open).toContain("size-6");
    expect(row({ folder: true, icon: Folder, label: "reports, folder" })).not.toContain("rotate-90");
  });

  it("draws a heading row taller and semibold, with its icon in a tile on phones", () => {
    const out = row({ heading: true, stacked: true, iconTile: true, level: 0 });
    expect(out).toContain("h-14 font-semibold");
    expect(out).toContain("flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted");
  });
});

describe("SandboxStatusCard", () => {
  it("running: the pill, gVisor, last active, packages, the three cells and Stop / Restart", () => {
    const out = card();
    expect(out).toContain('data-status="running"');
    expect(out).toContain('aria-label="Status: Running"');
    expect(out).toContain("bg-emerald-100 text-emerald-800");
    expect(out).toContain("Isolated with gVisor");
    expect(out).not.toContain("weaker isolation");
    expect(out).toContain("Last active 2 minutes ago");
    expect(out).toContain("2 packages");
    expect(out).toContain("1.4 GB of 2 GB");
    expect(out).toContain("12 min");
    expect(out).toContain("Organization: 140 of 600 min today");
    expect(out).toContain("1 CPU · 1 GB memory · 256 processes");
    expect(out).toContain("Stops after 15 min without use");
    expect(out).toContain('data-testid="sandbox-stop"');
    expect(out).toContain('data-testid="sandbox-restart"');
    expect(out).toContain('aria-label="Disk used"');
    expect(out).toContain('aria-label="CPU minutes today"');
  });

  it("says hardened (weaker isolation) unless the API reports gVisor, never more than is known", () => {
    expect(card({ runtime: "hardened-runc" })).toContain("Hardened container · weaker isolation");
    expect(card({ runtime: null })).toContain("Hardened container · weaker isolation");
  });

  it("stopped: no actions, and when it starts again", () => {
    const out = card({ state: "stopped", stopReason: "user" });
    expect(out).toContain('aria-label="Status: Stopped"');
    expect(out).toContain("Starts when Scout needs it.");
    expect(out).not.toContain('data-testid="sandbox-stop"');
  });

  it("disk full: the red blocking notice with the numbers, no actions", () => {
    const out = card({ state: "disk_full", stopReason: "disk_full", diskBytes: 2048 * MIB });
    expect(out).toContain('aria-label="Status: Disk full"');
    expect(out).toContain(
      "The sandbox is full (2 GB of 2 GB). Scout can't write files or run commands until you delete some.",
    );
    expect(out).toContain("border-red-200 bg-red-50 text-red-800");
    expect(out).not.toContain('data-testid="sandbox-restart"');
  });

  it("stopped by an admin, unavailable and not started yet each show their sentence", () => {
    const killed = card({ state: "killed", stopReason: "kill_switch" });
    expect(killed).toContain('aria-label="Status: Stopped by an admin"');
    expect(killed).toContain("An admin stopped all sandboxes. Files are kept.");
    const down = card({ state: "unavailable", stopReason: "service_down" });
    expect(down).toContain('aria-label="Status: Unavailable"');
    expect(down).toContain(
      "The sandbox service isn't reachable. Ask an admin to check Settings › Sandbox & Browser.",
    );
    expect(down).not.toContain('data-testid="sandbox-isolation"');
    const absent = card({ state: "absent", runtime: null, lastActiveAt: null });
    expect(absent).toContain('aria-label="Status: Not started yet"');
    expect(absent).toContain("No sandbox yet. It's created the first time Scout needs it.");
    // Nothing runs yet: no isolation is claimed.
    expect(absent).not.toContain('data-testid="sandbox-isolation"');
  });

  it("a stop reason names the stronger cause of a stopped sandbox", () => {
    expect(presentState({ state: "stopped", stopReason: "kill_switch" })).toBe("killed");
    expect(presentState({ state: "stopped", stopReason: "disk_full" })).toBe("disk_full");
    expect(presentState({ state: "stopped", stopReason: "idle" })).toBe("stopped");
  });

  it("shows the team-bot notice for team bots only", () => {
    const line =
      "Everyone who can use Scout works with these files. Files you upload are visible to its other conversations.";
    expect(card({ teamBot: true })).toContain(line);
    expect(card({ teamBot: false })).not.toContain(line);
  });

  it("puts Stop and Restart in their own 44 px row on phones", () => {
    const out = card({}, "row");
    expect(out).toMatch(/data-testid="sandbox-restart"[^>]*class="[^"]*h-11 flex-1/);
  });
});

describe("QuotaMeter", () => {
  const tone = (used: number) =>
    renderToStaticMarkup(<QuotaMeter used={used} max={100} label="Disk used" />).match(
      /data-tone="(\w+)"/,
    )?.[1];

  it("is primary below 80 %, amber from 80 % and destructive at the cap", () => {
    expect(tone(79)).toBe("ok");
    expect(tone(80)).toBe("warn");
    expect(tone(100)).toBe("full");
    expect(renderToStaticMarkup(<QuotaMeter used={79} max={100} label="x" />)).toContain("bg-primary");
    expect(renderToStaticMarkup(<QuotaMeter used={80} max={100} label="x" />)).toContain("bg-amber-500");
    expect(renderToStaticMarkup(<QuotaMeter used={100} max={100} label="x" />)).toContain("bg-destructive");
    expect(quotaTone(0, 0)).toBe("full");
  });

  it("has progressbar semantics with its values", () => {
    const out = renderToStaticMarkup(<QuotaMeter used={40} max={100} label="Disk used" />);
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-valuenow="40"');
    expect(out).toContain('aria-valuemax="100"');
  });
});

describe("sandboxTabVisible", () => {
  const ok = (state: SandboxStatusView["state"]) => ({
    isSuccess: true,
    isPending: false,
    isError: false,
    data: status({ state }),
  });
  const pending = { isSuccess: false, isPending: true, isError: false, data: undefined };

  it("shows the tab once the status answered, and hides it on the refusal", () => {
    expect(
      sandboxTabVisible({
        asked: false,
        status: ok("running"),
        refused: false,
        orgOff: false,
        capsSettled: true,
      }),
    ).toBe(true);
    expect(
      sandboxTabVisible({ asked: true, status: pending, refused: true, orgOff: false, capsSettled: true }),
    ).toBe(false);
  });

  it("keeps a deep link's tab while loading, and hides a never-started sandbox while the organization is off", () => {
    expect(
      sandboxTabVisible({ asked: true, status: pending, refused: false, orgOff: false, capsSettled: false }),
    ).toBe(true);
    expect(
      sandboxTabVisible({ asked: false, status: pending, refused: false, orgOff: false, capsSettled: false }),
    ).toBe(false);
    expect(
      sandboxTabVisible({
        asked: true,
        status: ok("absent"),
        refused: false,
        orgOff: true,
        capsSettled: true,
      }),
    ).toBe(false);
    expect(
      sandboxTabVisible({
        asked: false,
        status: ok("stopped"),
        refused: false,
        orgOff: true,
        capsSettled: true,
      }),
    ).toBe(true);
  });
});

describe("checkFiles (upload dialog)", () => {
  const file = (name: string, size: number): File =>
    Object.defineProperty(new File([], name), "size", { value: size });

  it("flags a name with a slash or a leading .., files over 50 MB, no room left, and existing names", () => {
    const states = checkFiles(
      [
        file("..env", 10),
        file("big.bin", 51 * MIB),
        file("q3.csv", 10),
        file("new.csv", 10),
        file("huge.csv", 5 * MIB),
      ],
      new Set(["q3.csv"]),
      1 * MIB,
    );
    expect(states[0]).toEqual({ kind: "error", message: "Names can't contain / or start with .." });
    expect(states[1]).toEqual({ kind: "error", message: "Over 50 MB" });
    expect(states[2]).toEqual({ kind: "conflict" });
    expect(states[3]).toEqual({ kind: "ready" });
    expect(states[4]?.kind).toBe("error");
    expect(states[4] && "message" in states[4] ? states[4].message : "").toMatch(
      /^Not enough space \(.+ free\)$/,
    );
  });
});
