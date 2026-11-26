import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Channels } from "./channels";
import { updatePanel } from "./update-panel";

const src = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8");

describe("the onboarding window's update panel (07.13.1, D-09)", () => {
  it("shows nothing when there is nothing to say", () => {
    expect(updatePanel(undefined)).toBeNull();
  });

  it("offers Restart to update when the update is ready", () => {
    expect(updatePanel({ kind: "ready", label: "Restart to update to v0.5.2" })).toEqual({
      button: { label: "Restart to update to v0.5.2", action: "restart", tone: "primary" },
    });
  });

  const URL = "https://github.com/VictorMinemu/open-collaborative-ai-workspace/releases/tag/v0.5.2";

  it("links the release page where the app cannot update itself (the .deb wording included)", () => {
    const label = "Update available (v0.5.2): download the .deb, or use the AppImage, which updates itself";
    expect(updatePanel({ kind: "link", label, url: URL })).toEqual({ link: { label, url: URL } });
  });

  it("shows progress and errors as a sentence only", () => {
    expect(updatePanel({ kind: "progress", label: "Downloading v0.5.2… 42%" })).toEqual({
      text: "Downloading v0.5.2… 42%",
    });
    expect(updatePanel({ kind: "error", label: "Could not check for updates. Try again later." })).toEqual({
      text: "Could not check for updates. Try again later.",
      tone: "warning",
    });
  });

  it("waits for the sessions with Cancel the restart", () => {
    expect(updatePanel({ kind: "waiting", label: "Waiting for 2 sessions to finish…" })).toEqual({
      text: "Waiting for 2 sessions to finish…",
      button: { label: "Cancel the restart", action: "cancelWait", tone: "secondary" },
    });
  });

  it("offers Move OCW to Applications, with the release link when an update is known", () => {
    const label = "Move OCW to Applications to get automatic updates";
    const button = { label, action: "moveToApplications", tone: "primary" };
    expect(updatePanel({ kind: "move", label })).toEqual({ button });
    const link = { label: "Update available (v0.5.2)", url: URL };
    expect(updatePanel({ kind: "move", label, link })).toEqual({ link, button });
  });
});

describe("the update channel belongs to the onboarding window only", () => {
  it("has one onboarding channel and the web app's preload never reaches it", () => {
    expect(Channels.onboardingUpdateAction).toBe("ocw-onboarding:update-action");
    expect(src("preload", "onboarding.ts")).toContain("Channels.onboardingUpdateAction");
    const webPreload = src("preload", "main.ts");
    expect(webPreload).not.toContain("onboardingUpdateAction");
    expect(webPreload).not.toContain("updateAction");
  });
});
