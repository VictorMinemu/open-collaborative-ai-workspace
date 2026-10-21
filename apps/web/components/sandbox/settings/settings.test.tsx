import {
  DEFAULT_SANDBOX_SETTINGS,
  type SandboxIsolationInfo,
  type SandboxSettings,
  type SandboxSettingsView,
} from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  addHost,
  addRegistries,
  EgressForm,
  HOST_DUPLICATE,
  HOST_INVALID,
  HOST_LIMIT,
  PACKAGE_REGISTRIES,
} from "./egress-form";
import { IsolationCard, isolationSentence, isolationVariant, unavailableReason } from "./isolation-card";
import { KillSwitchBanner, KillSwitchCard, killDialogBody, stoppedLine } from "./kill-switch-card";
import {
  LIMIT_FIELDS,
  type LimitsDraft,
  LimitsFields,
  limitsDraftOf,
  limitsFromDraft,
  SaveFeedback,
} from "./limits-form";
import { OrgSwitchCard, TURN_ON_TITLE, turnOnBody } from "./org-switch-card";

/**
 * Settings › Sandbox & Browser as static markup (07.8-19; D-09, D-11, D-12, UI-SPEC §4.2): the isolation card in its
 * four variants, the organization switch and its turn-on copy, the limits rows (usage, meters, inline validation, the
 * below-use warning), the network radio cards and the allowlist editor's rules, and the kill switch. Rendered in node.
 */

const decode = (s: string) =>
  s
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

const ISO: SandboxIsolationInfo = {
  status: "ok",
  runtime: "gvisor",
  dockerVersion: "29.8.2",
  running: { sandboxes: 3, browsers: 1 },
  browserSandbox: "chromium+gvisor",
};

const settings = (over: Partial<SandboxSettings> = {}): SandboxSettings => ({
  ...DEFAULT_SANDBOX_SETTINGS,
  version: 4,
  updatedAt: "2026-10-14T10:00:00.000Z",
  ...over,
});

const view = (over: Partial<SandboxSettingsView> = {}): SandboxSettingsView => ({
  settings: settings(),
  isolation: ISO,
  usage: { cpuMinutesToday: 140, diskBytesTotal: 9.4 * 1024 ** 3 },
  ...over,
});

describe("IsolationCard", () => {
  const card = (iso: Partial<SandboxIsolationInfo>) =>
    decode(renderToStaticMarkup(<IsolationCard isolation={{ ...ISO, ...iso }} />));

  it("says gVisor only when the API reports it, with the running counts", () => {
    const html = card({});
    expect(html).toContain('data-runtime="gvisor"');
    expect(html).toContain("Each bot's sandbox and browser run on gVisor");
    expect(html).toContain("3 sandboxes · 1 browser running now");
  });

  it("reads hardened for runc and for an ok status without a runtime (never a stronger claim)", () => {
    for (const runtime of ["hardened-runc", null] as const) {
      const html = card({ runtime });
      expect(html).toContain('data-runtime="hardened"');
      expect(html).toContain("Hardened containers (no gVisor)");
      expect(html).toContain("A kernel flaw could let a bot reach the server.");
      expect(html).toContain("infra/sandbox/README.md");
      expect(html).toContain("bg-amber-50 text-amber-900");
    }
  });

  it("shows the service down and Docker too old variants with their fixed copy", () => {
    const down = card({ status: "service_down", runtime: null });
    expect(down).toContain('data-runtime="down"');
    expect(down).toContain("The sandbox service isn't running");
    expect(down).toContain("docker compose --profile sandbox up -d");
    expect(down).not.toContain("running now");
    const old = card({ status: "docker_too_old" });
    expect(old).toContain('data-runtime="docker_old"');
    expect(old).toContain("Docker Engine 26 or later is needed");
  });

  it("names Chromium's container-only posture (D-14)", () => {
    expect(card({ runtime: "hardened-runc", browserSandbox: "container-only" })).toContain(
      "Browsers run without Chromium's own sandbox on this server",
    );
    expect(card({})).not.toContain("Chromium's own sandbox");
  });

  it("derives the sentence and the unavailable reason from the same report", () => {
    expect(isolationVariant({ ...ISO, runtime: "hardened-runc" })).toBe("hardened");
    expect(isolationSentence(ISO)).toBe("Each sandbox is isolated with gVisor.");
    expect(isolationSentence({ ...ISO, runtime: "hardened-runc" })).toBe(
      "This server has no gVisor, so sandboxes use hardened containers that share the server's kernel.",
    );
    expect(isolationSentence({ ...ISO, status: "service_down" })).toBeNull();
    expect(unavailableReason({ ...ISO, status: "service_down" })).toBe(
      "The sandbox service isn't running on this server.",
    );
    expect(unavailableReason(ISO)).toBeNull();
  });
});

describe("OrgSwitchCard", () => {
  const render = (enabled: boolean, iso: Partial<SandboxIsolationInfo> = {}) =>
    decode(
      renderToStaticMarkup(
        <OrgSwitchCard
          enabled={enabled}
          isolation={{ ...ISO, ...iso }}
          pending={false}
          onChange={async () => true}
        />,
      ),
    );

  it("is off by default with the off line, and a switch named for the organization", () => {
    const html = render(false);
    expect(html).toContain('data-testid="org-switch"');
    expect(html).toContain('data-enabled="off"');
    expect(html).toContain("Off by default.");
    expect(html).toContain('aria-label="Sandbox & Browser for the organization"');
    expect(html).not.toContain('data-testid="org-switch-reason"');
  });

  it("disables turning on with a visible reason while the service is down; on stays switchable off", () => {
    const off = render(false, { status: "service_down", runtime: null });
    expect(off).toContain("The sandbox service isn't running on this server.");
    expect(off).toMatch(
      /data-testid="org-switch-toggle"[^>]*data-disabled|data-disabled[^>]*data-testid="org-switch-toggle"/,
    );
    const on = render(true, { status: "service_down", runtime: null });
    expect(on).not.toContain('data-testid="org-switch-reason"');
  });

  it("asks with the isolation sentence of the server in use (P-02)", () => {
    expect(TURN_ON_TITLE).toBe("Turn on Sandbox & Browser for the organization?");
    const gvisor = turnOnBody(ISO).join(" ");
    expect(gvisor).toContain("keep files and run commands in their own isolated sandbox");
    expect(gvisor).toContain("you're responsible for following their terms");
    expect(gvisor).toContain("Each sandbox is isolated with gVisor.");
    expect(turnOnBody({ ...ISO, runtime: "hardened-runc" }).join(" ")).toContain(
      "sandboxes use hardened containers that share the server's kernel",
    );
  });
});

describe("Limits", () => {
  const render = (draft: Partial<LimitsDraft> = {}, v = view()) =>
    decode(
      renderToStaticMarkup(
        <LimitsFields
          view={v}
          draft={{ ...limitsDraftOf(v.settings.limits), ...draft }}
          onChange={() => {}}
        />,
      ),
    );

  it("shows each row's usage and a progressbar meter against the saved cap", () => {
    const html = render();
    expect(html).toContain("Sandboxes at once");
    expect(html).toContain("3 running now");
    expect(html).toContain("1 open now");
    expect(html).toContain("140 used today");
    expect(html).toContain("9.4 GB used");
    expect(html).toContain('aria-label="Sandboxes running"');
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuemax="10"[^>]*aria-valuenow="3"/);
    // Disk per bot in whole GB from the stored MB.
    expect(html).toMatch(
      /data-testid="limit-input-diskPerBotGb"[^>]*value="2"|value="2"[^>]*data-testid="limit-input-diskPerBotGb"/,
    );
  });

  it("says the range under an invalid value", () => {
    const html = render({ maxSandboxes: "101" });
    expect(html).toContain("Use a whole number from 0 to 100");
    expect(html).toContain('aria-invalid="true"');
    expect(render({ cpuMinutesPerDay: "1.5" })).toContain("Use a whole number from 1 to 100000");
  });

  it("allows a cap below current use and says what happens (amber)", () => {
    const html = render({ maxSandboxes: "2" });
    expect(html).toContain("3 are running now. New ones wait until fewer are running.");
    expect(html).toContain("text-amber-700");
    expect(render({ maxSandboxes: "3" })).not.toContain("New ones wait");
  });

  it("saves only valid drafts; unchanged rows keep the stored MB exactly", () => {
    const saved = { ...DEFAULT_SANDBOX_SETTINGS.limits, diskPerBotMb: 1500 };
    const draft = limitsDraftOf(saved);
    expect(draft.diskPerBotGb).toBe("1.5");
    expect(limitsFromDraft({ ...draft, maxSandboxes: "12" }, saved)).toEqual({ ...saved, maxSandboxes: 12 });
    expect(limitsFromDraft({ ...draft, diskTotalGb: "40" }, saved)?.diskTotalMb).toBe(40 * 1024);
    expect(limitsFromDraft({ ...draft, maxBrowsers: "51" }, saved)).toBeNull();
    expect(LIMIT_FIELDS.map((f) => f.label)).toEqual([
      "Sandboxes at once",
      "Browsers at once",
      "CPU per day (minutes)",
      "Disk per bot (GB)",
      "Disk in total (GB)",
    ]);
  });

  it("puts the save error, the conflict notice or the disabled reason under the button", () => {
    const fb = (p: Partial<Parameters<typeof SaveFeedback>[0]>) =>
      decode(
        renderToStaticMarkup(
          <SaveFeedback error={null} notice={null} disabledReason={null} testId="limits" {...p} />,
        ),
      );
    expect(fb({ error: "A limit is outside its allowed range" })).toContain('role="alert"');
    expect(fb({ notice: "Someone else saved" })).toContain('data-testid="limits-notice"');
    expect(fb({ disabledReason: "The sandbox service isn't running on this server." })).toContain(
      "isn't running",
    );
  });
});

describe("Network", () => {
  const render = (s: Partial<SandboxSettings> = {}) =>
    decode(
      renderToStaticMarkup(
        <EgressForm
          settings={settings(s)}
          disabledReason={null}
          notice={null}
          pending={false}
          onEdit={() => {}}
          onSave={async () => ({ kind: "saved" })}
        />,
      ),
    );

  it("has two fieldsets of three radio cards; defaults Browser = Public, Shell = Allowlist (D-11)", () => {
    const html = render();
    expect(html.match(/<fieldset/g)).toHaveLength(2);
    expect(html).toContain(">Browser</legend>");
    expect(html).toContain(">Sandbox shell</legend>");
    expect(html.match(/type="radio"/g)).toHaveLength(6);
    expect(html).toMatch(/data-testid="egress-browser-public"[^>]*checked=""/);
    expect(html).toMatch(/data-testid="egress-shell-allowlist"[^>]*checked=""/);
    expect(html).not.toMatch(/data-testid="egress-browser-(off|allowlist)"[^>]*checked=""/);
    expect(html).toContain("Only the hosts below");
    expect(html).toContain("Any public address");
    expect(html).toContain("No internet");
    // An Allowlist part shows the editor.
    expect(html).toContain('data-testid="egress-allowlist"');
    expect(html).toContain("Add package registries");
  });

  it("hides the allowlist editor when neither part uses it", () => {
    expect(render({ sandboxEgress: "off", browserEgress: "public" })).not.toContain("egress-allowlist");
  });

  it("lists the saved hosts as removable chips", () => {
    const html = render({ allowHosts: ["pypi.org", "*.example.com"] });
    expect(html).toContain('data-host="pypi.org"');
    expect(html).toContain('aria-label="Remove *.example.com"');
  });

  it("accepts host, host:port and *.domain, lower-cased; refuses URLs, duplicates and the 65th", () => {
    expect(addHost([], "api.example.com")).toEqual({ hosts: ["api.example.com"] });
    expect(addHost([], " API.Example.com:8443 ")).toEqual({ hosts: ["api.example.com:8443"] });
    expect(addHost([], "*.example.com")).toEqual({ hosts: ["*.example.com"] });
    expect(addHost([], "https://x/y")).toEqual({ error: HOST_INVALID });
    expect(addHost(["pypi.org"], "pypi.org")).toEqual({ error: HOST_DUPLICATE });
    const full = Array.from({ length: 64 }, (_, i) => `h${i}.example.com`);
    expect(addHost(full, "one-more.example.com")).toEqual({ error: HOST_LIMIT });
    expect(HOST_LIMIT).toBe("Up to 64 hosts");
  });

  it("adds the four package registries and skips the ones already listed", () => {
    expect(addRegistries([])).toEqual({ hosts: [...PACKAGE_REGISTRIES], added: 4 });
    const res = addRegistries(["pypi.org", "api.example.com"]);
    expect(res.added).toBe(3);
    expect(res.hosts.filter((h) => h === "pypi.org")).toHaveLength(1);
    expect(addRegistries([...PACKAGE_REGISTRIES]).added).toBe(0);
  });
});

describe("Kill switch", () => {
  const killed = { at: "2026-10-14T10:31:00.000Z", by: { id: "u1", displayName: "Ana Pérez" } };

  it("asks with the counts, including anyone signing in", () => {
    expect(killDialogBody({ sandboxes: 3, browsers: 1 })).toBe(
      "3 sandboxes and 1 browser stop now, including anyone signing in. Bots can't use them until you resume. Files and saved sign-ins are kept.",
    );
  });

  it("the banner says who and when, as a status with a Resume button", () => {
    const html = decode(
      renderToStaticMarkup(<KillSwitchBanner killed={killed} pending={false} onResume={() => {}} />),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("All sandboxes and browsers are stopped");
    expect(stoppedLine(killed)).toMatch(/^Stopped by Ana Pérez · Oct 14, \d\d:\d\d$/);
    expect(stoppedLine({ ...killed, by: null })).toMatch(/^Stopped · Oct 14/);
    expect(html).toContain("Resume");
  });

  it("the card offers Stop, and Resume instead while engaged", () => {
    const card = (k: typeof killed | null) =>
      decode(
        renderToStaticMarkup(
          <KillSwitchCard
            killed={k}
            running={{ sandboxes: 0, browsers: 0 }}
            pending={false}
            onKill={async () => true}
            onResume={() => {}}
          />,
        ),
      );
    expect(card(null)).toContain("Stop all sandboxes and browsers");
    expect(card(null)).toContain("border-destructive/30");
    expect(card(killed)).toContain('data-testid="kill-switch-card-resume"');
    expect(card(killed)).not.toContain("kill-switch-stop");
  });
});
