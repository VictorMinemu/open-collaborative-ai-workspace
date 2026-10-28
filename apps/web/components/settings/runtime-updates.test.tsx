import type { Device, RuntimeMaintenanceStatus, RuntimeUpdateRun } from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DeviceRuntimeUpdates,
  lastRunText,
  RunList,
  runTrigger,
  runtimeUpdateStatus,
} from "./runtime-updates";

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
