import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkSession, WorkSessionBrowserState } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionFooter } from "../session-footer";
import { BROWSER_CHIP_COPY, BrowserStatusChip, browserChipCopy } from "./browser-status-chip";

/**
 * 07.13-11 (D-19): the session footer says whether the session's browser is available and, when it is not, which of
 * the three switches is off and who can turn it on. Static markup in node (the web project has no DOM).
 */

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const chip = (state: WorkSessionBrowserState | undefined) =>
  renderToStaticMarkup(<BrowserStatusChip state={state} />);

describe("BrowserStatusChip (D-19)", () => {
  it.each([
    [{ status: "available", live: false }, "Browser"],
    [{ status: "available", live: true }, "Browser · live"],
    [{ status: "off_policy", live: false }, "Browser off (organization)"],
    [{ status: "off_device", live: false }, "Browser off on this device"],
    [{ status: "update_device", live: false }, "Update this device to use the browser"],
  ] as const)("%j reads %s", (state, label) => {
    const html = chip(state);
    expect(text(html)).toBe(label);
    expect(html).toContain('data-testid="browser-status-chip"');
    expect(html).toContain(`data-status="${state.status}"`);
    expect(browserChipCopy(state).label).toBe(label);
  });

  it("names who can change each state in its tooltip (and its accessible name)", () => {
    expect(BROWSER_CHIP_COPY.available.tip).toBe("Agents in this session can open web pages on its device");
    expect(BROWSER_CHIP_COPY.off_policy.tip).toBe(
      "A workspace admin can allow it in Settings › Work Zone policy",
    );
    expect(BROWSER_CHIP_COPY.off_device.tip).toBe(
      "The device's owner can allow it from the OCW desktop app or with ocw-runtime browser on",
    );
    expect(BROWSER_CHIP_COPY.update_device.tip).toBe(
      "The device's owner can update the OCW desktop app or the runtime on that device",
    );
    for (const status of ["available", "off_policy", "off_device", "update_device"] as const) {
      const html = chip({ status, live: false });
      // A tap target: a button with the tooltip text as its accessible description.
      expect(html).toMatch(/^<button[^>]*type="button"/);
      expect(html).toContain(`aria-label="${BROWSER_CHIP_COPY[status].label}. ${BROWSER_CHIP_COPY[status].tip}"`);
    }
  });

  it("renders nothing when the session has no browser field (an older API)", () => {
    expect(chip(undefined)).toBe("");
  });

  it("truncates on a phone and keeps a 44 px hit area there", () => {
    const html = chip({ status: "update_device", live: false });
    const button = html.match(/^<button[^>]*>/)?.[0] ?? "";
    expect(button).toContain("min-w-0");
    expect(button).toContain("max-sm:min-h-11");
    expect(html).toContain("truncate");
  });

  it("uses only tokens the footer and the Full access badge already use", () => {
    const source = readFileSync(join(__dirname, "browser-status-chip.tsx"), "utf8");
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(source).not.toMatch(/\b(?:bg|text|border)-(?:sky|blue|indigo|teal|cyan|lime|pink|rose)-/);
  });
});

function session(browser?: WorkSessionBrowserState): WorkSession {
  return {
    worktree: true,
    deviceName: "Victor's Mac",
    deviceOnline: true,
    runtime: "claude-code",
    diffStat: null,
    branch: "feat/x",
    ...(browser ? { browser } : {}),
  } as unknown as WorkSession;
}

describe("SessionFooter browser chip (D-19)", () => {
  it("shows the chip next to the device details", () => {
    const html = renderToStaticMarkup(<SessionFooter session={session({ status: "off_device", live: false })} />);
    expect(text(html)).toContain("Browser off on this device");
    const device = html.indexOf("Victor&#x27;s Mac");
    const chipAt = html.indexOf('data-testid="browser-status-chip"');
    const branch = html.indexOf("feat/x");
    expect(device).toBeGreaterThan(-1);
    expect(chipAt).toBeGreaterThan(device);
    expect(chipAt).toBeLessThan(branch);
  });

  it("shows nothing about the browser for a session DTO without the field", () => {
    const html = renderToStaticMarkup(<SessionFooter session={session()} />);
    expect(html).not.toContain("browser-status-chip");
    expect(text(html)).not.toContain("Browser");
  });
});
