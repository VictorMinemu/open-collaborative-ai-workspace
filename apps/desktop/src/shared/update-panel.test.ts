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
