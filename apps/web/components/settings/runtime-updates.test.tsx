import {
  type Device,
  type DeviceRuntimeMaintenance,
  RUNTIME_SELF_BLOCK_SENTENCES,
  type RuntimeMaintenanceStatus,
  type RuntimeSelfStatus,
  type RuntimeUpdateRun,
} from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompatFlag } from "./devices-settings";
import {
  compatFlag,
  DeviceRuntimeUpdates,
  lastRunText,
  RunList,
  runTrigger,
  runtimeHistoryTitle,
  runtimeSelfView,
  runtimeUpdateStatus,
} from "./runtime-updates";
import { RuntimeUpdatesField } from "./work-zone-policy-settings";

/**
 * Settings › Devices › Runtime updates (07.11-10, D-05, D-06, PD-15): the status pill for every state, the rows the
 * owner and admins see, and the history list. Pure rendering of what the API sent (static markup in node); the API
 * decides who sees the block and who may press "Update now".
 */

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

function status(over: Partial<RuntimeMaintenanceStatus> = {}): RuntimeMaintenanceStatus {
  return {
    runtime: "claude-code",
    installedVersion: "2.1.290",
    method: "native",
    location: "~/.local/bin",
    canUpdate: true,
    reason: null,
    updateCommand: "claude update",
    channel: "latest",
    latestVersion: "2.1.290",
    advisory: "current",
    installedCompatibility: "supported",
    candidateCompatibility: "supported",
    state: "idle",
    pendingSince: null,
    stale: false,
    lastRun: null,
    checkedAt: ago(5 * MIN),
    ...over,
  };
}

const ID = "01a11635-d6e7-7c87-9f17-0000000000d1";
const OWNER = "01a11635-d6e7-7c87-9f17-0000000000a1";

function device(over: Partial<Device> = {}): Device {
  return {
    id: ID,
    ownerUserId: OWNER,
    ownerName: "Owen",
    name: "Build server",
    platform: "linux",
    status: "online",
    shared: false,
    fullAccessOptIn: false,
    shareMaxMode: "default",
    lastSeenAt: null,
    runtimes: [],
    daemonVersion: null,
    projectCount: 0,
    revokedAt: null,
    createdAt: ago(10 * HOUR),
    viewerCan: ["device.update", "device.revoke", "device.maintain"],
    runtimeMaintenance: {
      runtimes: [
        status({ latestVersion: "2.1.300", advisory: "behind" }),
        status({
          runtime: "codex",
          installedVersion: "0.165.0",
          method: "codex_standalone",
          location: "~/.codex/packages/standalone",
          latestVersion: "0.165.0",
          updateCommand: null,
        }),
      ],
      localLevel: "automatic",
      localLevelSource: "config",
      effectiveLevel: "notify",
      orgLevel: "notify",
      reportedAt: ago(MIN),
    },
    ...over,
  };
}

function render(node: ReactElement): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("runtimeUpdateStatus", () => {
  it.each<[string, Partial<RuntimeMaintenanceStatus>, string, string]>([
    ["current", {}, "Up to date", "success"],
    ["behind", { advisory: "behind", latestVersion: "2.1.300" }, "2.1.300 available", "brand"],
    ["running", { state: "running", advisory: "behind" }, "Updating…", "outline"],
    ["draining", { state: "draining" }, "Updating…", "outline"],
    ["queued", { state: "queued" }, "Updating…", "outline"],
    ["pending", { state: "pending", pendingSince: ago(2 * HOUR) }, "Waiting for an idle moment", "outline"],
    [
      "failed and still behind",
      {
        advisory: "behind",
        latestVersion: "2.1.300",
        lastRun: {
          runId: "01a11635-d6e7-7c87-9f17-0000000000f1",
          outcome: "failed",
          at: ago(10 * MIN),
          fromVersion: "2.1.290",
          toVersion: null,
        },
      },
      "Update failed",
      "destructive",
    ],
    ["unsupported", { installedCompatibility: "unsupported" }, "Unsupported version", "warning"],
    [
      "broken beats behind",
      { installedCompatibility: "broken", advisory: "behind", latestVersion: "2.1.300" },
      "Can't run sessions",
      "destructive",
    ],
    ["unknown", { advisory: "unknown", latestVersion: null, checkedAt: null }, "Not checked", "outline"],
    [
      "not installed",
      { method: "not_installed", installedVersion: null, reason: "not_installed", canUpdate: false },
      "Not installed",
      "outline",
    ],
  ])("%s → %s", (_name, over, label, tone) => {
    const pill = runtimeUpdateStatus(status(over), NOW);
    expect(pill.label).toBe(label);
    expect(pill.tone).toBe(tone);
    expect(pill.busy).toBe(label === "Updating…");
  });

  it("says since when an update has been waiting", () => {
    expect(runtimeUpdateStatus(status({ state: "pending", pendingSince: ago(3 * HOUR) }), NOW).title).toBe(
      "since 3 hours ago",
    );
  });

  it("words the last run, else the last check", () => {
    const run = (outcome: "succeeded" | "failed", toVersion: string | null) =>
      status({
        lastRun: {
          runId: "01a11635-d6e7-7c87-9f17-0000000000f1",
          outcome,
          at: ago(3 * HOUR),
          fromVersion: "2.1.290",
          toVersion,
        },
      });
    expect(lastRunText(run("succeeded", "2.1.300"), NOW)).toBe("Updated 2.1.290 → 2.1.300 · 3 hours ago");
    expect(lastRunText(run("failed", null), NOW)).toBe("Update failed 3 hours ago");
    expect(lastRunText(status(), NOW)).toBe("Checked 5 minutes ago");
    expect(lastRunText(status({ checkedAt: null }), NOW)).toBeNull();
  });
});

describe("DeviceRuntimeUpdates", () => {
  it("renders one row per runtime with its state, method, location and one Update now per updatable runtime", () => {
    const html = render(<DeviceRuntimeUpdates device={device()} />);
    expect(count(html, 'data-testid="runtime-update-row"')).toBe(2);
    expect(html).toContain('data-runtime="claude-code" data-state="idle"');
    expect(html).toContain("2.1.300 available");
    expect(html).toContain("Up to date");
    expect(html).toContain("Native installer · ~/.local/bin");
    expect(html).toContain("Standalone installer · ~/.codex/packages/standalone");
    expect(count(html, 'data-testid="runtime-update-now"')).toBe(2);
    expect(count(html, 'data-testid="runtime-update-history"')).toBe(2);
    expect(html).toContain("Organization: Notify only · This device: Automatic");
    expect(html).toContain("New versions are reported; install them with Update now.");
    expect(html).not.toContain("Set on the device");
  });

  it("explains a needs-admin install with its command and offers no Update now", () => {
    const d = device();
    d.runtimeMaintenance = {
      ...d.runtimeMaintenance!,
      runtimes: [
        status({
          method: "npm",
          location: null,
          canUpdate: false,
          reason: "needs_admin",
          updateCommand: "sudo npm install -g @anthropic-ai/claude-code@latest",
        }),
      ],
    };
    const html = render(<DeviceRuntimeUpdates device={d} />);
    expect(html).toContain("Needs admin on this machine:");
    expect(html).toContain("sudo npm install -g @anthropic-ai/claude-code@latest");
    expect(html).not.toContain('data-testid="runtime-update-now"');
  });

  it("names a manual install and an install whose updates are disabled", () => {
    const d = device();
    d.runtimeMaintenance = {
      ...d.runtimeMaintenance!,
      runtimes: [
        status({
          method: "homebrew_cask",
          canUpdate: false,
          reason: "manual",
          updateCommand: "brew upgrade --cask claude-code",
        }),
        status({ runtime: "codex", canUpdate: false, reason: "updates_disabled", updateCommand: null }),
      ],
    };
    const html = render(<DeviceRuntimeUpdates device={d} />);
    expect(html).toContain("Installed with Homebrew. Update it with the tool that installed it.");
    expect(html).toContain("brew upgrade --cask claude-code");
    expect(html).toContain("Updates are disabled on this machine (DISABLE_UPDATES).");
    expect(html).not.toContain('data-testid="runtime-update-now"');
  });

  it("shows the device's lower level as set on the device", () => {
    const d = device();
    d.runtimeMaintenance = {
      ...d.runtimeMaintenance!,
      orgLevel: "automatic",
      localLevel: "off",
      effectiveLevel: "off",
    };
    const html = render(<DeviceRuntimeUpdates device={d} />);
    expect(html).toContain("Organization: Automatic · This device: Off");
    expect(html).toContain("Set on the device");
    expect(html).toContain("Updates are off.");
    // Pressable only when the device would run it: the level is off.
    expect(html).toContain('title="Runtime updates are off"');
  });

  it("disables Update now while the device is offline or an update waits", () => {
    const offline = render(<DeviceRuntimeUpdates device={device({ status: "offline" })} />);
    expect(offline).toContain('title="The device is offline"');
    const d = device();
    d.runtimeMaintenance = {
      ...d.runtimeMaintenance!,
      runtimes: [status({ state: "pending", advisory: "behind", latestVersion: "2.1.300" })],
    };
    expect(render(<DeviceRuntimeUpdates device={d} />)).toContain(
      'title="An update is waiting for an idle moment"',
    );
  });

  it("disables Update now on a runtime that is already current, and keeps it when the latest version is unknown", () => {
    const d = device();
    d.runtimeMaintenance = { ...d.runtimeMaintenance!, runtimes: [status({ advisory: "current" })] };
    expect(render(<DeviceRuntimeUpdates device={d} />)).toContain('title="Already up to date"');
    d.runtimeMaintenance = {
      ...d.runtimeMaintenance,
      runtimes: [status({ advisory: "unknown", latestVersion: null })],
    };
    expect(render(<DeviceRuntimeUpdates device={d} />)).not.toContain('title="Already up to date"');
  });

  it("offers no button to a viewer without device.maintain, and no block without runtimeMaintenance", () => {
    const html = render(<DeviceRuntimeUpdates device={device({ viewerCan: ["device.update"] })} />);
    expect(count(html, 'data-testid="runtime-update-row"')).toBe(2);
    expect(html).not.toContain('data-testid="runtime-update-now"');
    expect(html).not.toContain('data-testid="runtime-update-history"');
    const { runtimeMaintenance: _m, ...bare } = device();
    expect(render(<DeviceRuntimeUpdates device={bare} />)).toBe("");
  });

  it("turns the icon tile amber when a version can't run sessions", () => {
    const d = device();
    d.runtimeMaintenance = {
      ...d.runtimeMaintenance!,
      runtimes: [status({ installedCompatibility: "broken" })],
    };
    const html = render(<DeviceRuntimeUpdates device={d} />);
    expect(html).toContain("bg-amber-100");
    expect(html).toContain("Can&#x27;t run sessions");
  });
});

describe("the history list", () => {
  const base: RuntimeUpdateRun = {
    id: "01a11635-d6e7-7c87-9f17-0000000000f1",
    runtime: "claude-code",
    trigger: "automatic",
    state: "succeeded",
    requestedBy: null,
    fromVersion: "2.1.290",
    toVersion: "2.1.300",
    candidate: "2.1.300",
    method: "native",
    output: "Updated <b>to</b> 2.1.300",
    error: null,
    requestedAt: null,
    startedAt: ago(3 * HOUR),
    finishedAt: ago(3 * HOUR - MIN),
  };
  const list = (runs: RuntimeUpdateRun[], over: Partial<{ isPending: boolean; isError: boolean }> = {}) =>
    render(
      <RunList
        history={{
          data: runs,
          isPending: false,
          isError: false,
          isFetching: false,
          refetch: () => undefined,
          ...over,
        }}
      />,
    );

  it("lists runs in the API's order with trigger, versions, outcome and a collapsed output", () => {
    const html = list([
      {
        ...base,
        id: "01a11635-d6e7-7c87-9f17-0000000000f3",
        trigger: "manual",
        state: "refused",
        requestedBy: { id: OWNER, name: "Owen" },
        fromVersion: null,
        toVersion: null,
        candidate: null,
        output: null,
        error: "already up to date",
      },
      { ...base, id: "01a11635-d6e7-7c87-9f17-0000000000f2", trigger: "local", state: "failed" },
      base,
    ]);
    expect(count(html, 'data-testid="runtime-update-run"')).toBe(3);
    const order = ["By Owen", "On the device", "Automatic"].map((t) => html.indexOf(t));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain("Refused");
    expect(html).toContain("already up to date");
    expect(html).toContain("Failed");
    expect(html).toContain("Succeeded");
    expect(html).toContain("2.1.290 → 2.1.300");
    // The output is plain text in a closed <details> (T-07.11-10-03).
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain("Updated &lt;b&gt;to&lt;/b&gt; 2.1.300");
  });

  it("says when there is nothing yet, and shows skeletons while loading", () => {
    expect(list([])).toContain("No updates yet.");
    expect(list([], { isPending: true })).toContain('aria-busy="true"');
  });

  it("names who started a run", () => {
    expect(runTrigger(base)).toBe("Automatic");
    expect(runTrigger({ ...base, trigger: "local" })).toBe("On the device");
    expect(runTrigger({ ...base, trigger: "manual", requestedBy: { id: OWNER, name: "Owen" } })).toBe(
      "By Owen",
    );
  });
});

/** 07.11-10 (D-04): every viewer sees the manifest's verdict after a runtime's version; (D-02) the org level select. */
describe("compatibility flags and the policy select", () => {
  it("adds a suffix only for versions that are too old or can't run sessions", () => {
    expect(compatFlag("unsupported")?.text).toBe("· older than supported");
    expect(compatFlag("broken")?.text).toBe("· can't run sessions");
    for (const c of ["supported", "graceful", "unknown", undefined] as const)
      expect(compatFlag(c)).toBeNull();
  });

  it("renders the chip suffix from the device's runtimeCompatibility", () => {
    const flag = (compat: Device["runtimeCompatibility"]) =>
      render(<CompatFlag device={device({ runtimeCompatibility: compat })} runtime="claude-code" />);
    expect(flag({ "claude-code": "unsupported" })).toContain("· older than supported");
    expect(flag({ "claude-code": "unsupported" })).toContain('data-testid="runtime-compat-flag"');
    expect(flag({ "claude-code": "broken" })).toContain("· can&#x27;t run sessions");
    expect(flag({ "claude-code": "supported" })).toBe("");
    expect(flag({ codex: "broken" })).toBe("");
    expect(flag(undefined)).toBe("");
  });

  it("shows the saved level's description and the note about devices", () => {
    const html = render(<RuntimeUpdatesField value="notify" onChange={() => undefined} />);
    expect(html).toContain('data-testid="policy-runtime-updates"');
    expect(html).toContain("Devices report new versions; the device owner or an admin presses Update now.");
    expect(html).toContain("A device owner can lower this on the device");
  });
});

/** The 07.11 rows' markup, recorded from the 07.11 code before the Runtime row existed (07.17.1-06). */
const cliRows = (html: string) => html.match(/<li data-testid="runtime-update-row"[\s\S]*?<\/li>/g) ?? [];

describe("the 07.11 rows", () => {
  it("render the same markup as before the Runtime row", () => {
    const rows = cliRows(render(<DeviceRuntimeUpdates device={device()} />));
    expect(rows).toHaveLength(2);
    expect(rows.join("\n")).toMatchSnapshot();
  });

  it("render the same markup on a service device that shows the Runtime row", () => {
    const html = render(<DeviceRuntimeUpdates device={service()} />);
    expect(html).toContain('data-testid="runtime-self-row"');
    expect(cliRows(html).join("\n")).toBe(cliRows(render(<DeviceRuntimeUpdates device={device()} />)).join("\n"));
  });
});

// ---- 07.17.1-06 (D-01, D-04, D-05, D-07, D-10, PD-17): the OCW runtime's own row ----

const INSTALLED = "1a2b3c4d5e6f";
const SERVED = "abcdef012345";

function self(over: Partial<RuntimeSelfStatus> = {}): RuntimeSelfStatus {
  return {
    version: "0.3.1",
    build: INSTALLED,
    supervised: true,
    canUpdate: true,
    reason: null,
    servedVersion: "0.3.2",
    servedBuild: SERVED,
    state: "idle",
    pendingSince: null,
    lastRun: null,
    checkedAt: ago(5 * MIN),
    ...over,
  };
}

/** A headless server whose runtime is behind what the workspace serves, unless told otherwise. */
function service(
  s: Partial<RuntimeSelfStatus> | null = {},
  over: Partial<Device> = {},
  m: Partial<DeviceRuntimeMaintenance> = {},
): Device {
  const d = device({ hostKind: "service", daemonVersion: "0.3.1", ...over });
  const { self: _s, ...rest } = d.runtimeMaintenance!;
  d.runtimeMaintenance = {
    ...rest,
    ...(s ? { self: self(s) } : {}),
    served: { version: "0.3.2", build: SERVED },
    ...m,
  };
  return d;
}

const failedRun = {
  runId: "01a11635-d6e7-7c87-9f17-0000000000f9",
  outcome: "failed" as const,
  at: ago(10 * MIN),
  fromVersion: "0.3.1",
  toVersion: null,
  fromBuild: INSTALLED,
  toBuild: null,
};

/** The Runtime row's own markup (the first item of the list). */
const selfRow = (html: string) => html.match(/<li data-testid="runtime-self-row"[\s\S]*?<\/li>/)?.[0] ?? "";
/** The Update button's opening tag, or "" when there is none. */
const updateButton = (html: string) => html.match(/<button[^>]*data-testid="runtime-self-update-now"[^>]*>/)?.[0] ?? "";

describe("runtimeSelfView", () => {
  it("compares the installed build with the served one", () => {
    expect(runtimeSelfView(service())).toEqual({
      kind: "behind",
      installed: `0.3.1 · ${INSTALLED}`,
      served: `0.3.2 · ${SERVED}`,
      servedVersion: "0.3.2",
      canPress: true,
    });
    expect(runtimeSelfView(service({ build: SERVED, version: "0.3.2" }))).toMatchObject({
      kind: "current",
      installed: `0.3.2 · ${SERVED}`,
    });
  });

  it.each<[RuntimeSelfStatus["state"], string]>([
    ["downloading", "Downloading…"],
    ["installing", "Installing…"],
    ["waiting", "Waiting for sessions to finish"],
    ["restarting", "Restarting…"],
  ])("%s is busy: %s", (state, label) => {
    expect(runtimeSelfView(service({ state }))).toMatchObject({ kind: "busy", label });
  });

  it("keeps a retry after a failed run, says why a blocked device can't update, and when nothing is served", () => {
    expect(runtimeSelfView(service({ lastRun: failedRun }))).toMatchObject({ kind: "failed", canPress: true });
    expect(runtimeSelfView(service({ reason: "not_supervised", canUpdate: false }))).toMatchObject({
      kind: "blocked",
      note: RUNTIME_SELF_BLOCK_SENTENCES.not_supervised,
    });
    expect(runtimeSelfView(service({}, {}, { served: null }))).toMatchObject({ kind: "not_served" });
  });
});

describe("RuntimeSelfRow", () => {
  it("shows installed vs served, the available version and one Update and History on a server that is behind", () => {
    const html = render(<DeviceRuntimeUpdates device={service()} />);
    const row = selfRow(html);
    expect(row).toContain('data-runtime="ocw-runtime"');
    expect(row).toContain('data-view="behind"');
    expect(row).toMatch(/data-testid="runtime-self-version"[^>]*>0\.3\.1 · 1a2b3c4d5e6f</);
    expect(row).toMatch(/data-testid="runtime-self-served"[^>]*>Your workspace serves 0\.3\.2 · abcdef012345</);
    expect(row).toMatch(/data-testid="runtime-self-status"[^>]*>0\.3\.2 available</);
    expect(updateButton(row)).toContain('aria-label="Update the OCW runtime"');
    expect(updateButton(row)).not.toContain("disabled");
    expect(row).toMatch(/data-testid="runtime-self-history"[^>]*aria-label="OCW runtime update history"|aria-label="OCW runtime update history"[^>]*data-testid="runtime-self-history"/);
  });

  it("is the first item of the list, which names every runtime on the device", () => {
    const html = render(<DeviceRuntimeUpdates device={service()} />);
    expect(html).toContain('aria-label="Runtimes on this device"');
    expect(html).not.toContain("Coding agents on this device");
    const list = html.slice(html.indexOf('aria-label="Runtimes on this device"'));
    expect(list.indexOf('data-testid="runtime-self-row"')).toBeLessThan(list.indexOf('data-testid="runtime-update-row"'));
    expect(count(html, 'data-testid="runtime-self-row"')).toBe(1);
  });

  it("says what the device's level means for the runtime", () => {
    const at = (effectiveLevel: "automatic" | "notify" | "off") =>
      selfRow(render(<DeviceRuntimeUpdates device={service({}, {}, { effectiveLevel })} />));
    expect(at("automatic")).toContain("Updates by itself when no session runs");
    expect(at("off")).toContain("Automatic checks are off. Update still works.");
    expect(at("notify")).not.toContain("Updates by itself");
    expect(at("notify")).not.toContain("Automatic checks are off");
  });

  it("offers no enabled Update when up to date, blocked or busy, and keeps it after a failure", () => {
    const row = (s: Partial<RuntimeSelfStatus>) => selfRow(render(<DeviceRuntimeUpdates device={service(s)} />));
    const current = row({ build: SERVED, version: "0.3.2" });
    expect(current).toMatch(/data-testid="runtime-self-status"[^>]*>Up to date</);
    expect(updateButton(current)).toBe("");
    const blocked = row({ reason: "not_supervised", canUpdate: false });
    expect(blocked).toContain(RUNTIME_SELF_BLOCK_SENTENCES.not_supervised);
    expect(blocked).toContain('data-testid="runtime-self-note"');
    expect(updateButton(blocked)).toBe("");
    for (const state of ["downloading", "installing", "waiting", "restarting"] as const) {
      const busy = row({ state });
      const button = updateButton(busy);
      expect(button === "" || button.includes("disabled")).toBe(true);
      expect(busy).toContain("animate-spin");
    }
    const failed = row({ lastRun: failedRun });
    expect(failed).toMatch(/data-testid="runtime-self-status"[^>]*>Update failed</);
    expect(updateButton(failed)).not.toContain("disabled");
  });

  it("offers no Update to a viewer without device.maintain", () => {
    const row = selfRow(render(<DeviceRuntimeUpdates device={service({}, { viewerCan: ["device.update"] })} />));
    expect(row).toContain('data-view="behind"');
    expect(updateButton(row)).toBe("");
    expect(row).not.toContain('data-testid="runtime-self-history"');
  });

  it("uses no faded text: no opacity utility and no alpha text colour in any view", () => {
    for (const d of [
      service(),
      service({ build: SERVED }),
      service({ state: "waiting" }),
      service({ lastRun: failedRun }),
      service({ reason: "node_too_old" }),
    ]) {
      const classes = [...selfRow(render(<DeviceRuntimeUpdates device={d} />)).matchAll(/class="([^"]*)"/g)].map(
        (c) => c[1] ?? "",
      );
      expect(classes.length).toBeGreaterThan(0);
      for (const c of classes) expect(c).not.toMatch(/(^|\s)opacity-|text-muted-foreground\//);
    }
  });
});

describe("the OCW runtime's history", () => {
  it("lists a run with both builds", () => {
    const html = render(
      <RunList
        history={{
          data: [
            {
              id: "01a11635-d6e7-7c87-9f17-0000000000fa",
              runtime: "ocw-runtime",
              trigger: "manual",
              state: "succeeded",
              requestedBy: { id: OWNER, name: "Owen" },
              fromVersion: "0.3.1",
              toVersion: "0.3.2",
              fromBuild: INSTALLED,
              toBuild: SERVED,
              candidate: "0.3.2",
              method: "ocw_bundle",
              output: null,
              error: null,
              requestedAt: ago(HOUR),
              startedAt: ago(HOUR),
              finishedAt: ago(HOUR - MIN),
            },
          ],
          isPending: false,
          isError: false,
          isFetching: false,
          refetch: () => undefined,
        }}
      />,
    );
    expect(html).toContain("OCW runtime");
    expect(html).toContain(`0.3.1 · ${INSTALLED} → 0.3.2 · ${SERVED}`);
  });

  it("titles the sheet with the target's label", () => {
    expect(runtimeHistoryTitle("ocw-runtime")).toBe("OCW runtime · newest first");
    expect(runtimeHistoryTitle("codex")).toBe("Codex · newest first");
    expect(runtimeHistoryTitle(undefined)).toBe("All coding agents · newest first");
  });
});
