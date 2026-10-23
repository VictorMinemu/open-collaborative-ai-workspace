import { describe, expect, it } from "vitest";
import { isSessionPath, projectTabOf } from "./work-zone-routes";

/** R8: the Work Zone layout keeps a session open when its module turns off; the project pages are not sessions. */
describe("isSessionPath", () => {
  it("is a session id under /work-zone", () => {
    expect(isSessionPath("/work-zone/abc")).toBe(true);
    expect(isSessionPath("/work-zone/01a11635-d6e7-7c87-9f17-0000000000a1")).toBe(true);
  });

  it("is never the home, the projects index, a project page or a deeper path", () => {
    expect(isSessionPath("/work-zone")).toBe(false);
    expect(isSessionPath("/work-zone/")).toBe(false);
    expect(isSessionPath("/work-zone/projects")).toBe(false);
    expect(isSessionPath("/work-zone/projects/01a11635-d6e7-7c87-9f17-0000000000a1")).toBe(false);
    expect(isSessionPath("/work-zone/abc/def")).toBe(false);
    expect(isSessionPath("/chat/abc")).toBe(false);
  });
});

/** UI-SPEC "Project pages": `?tab=settings` deep-links Settings; an unknown tab falls back to Sessions. */
describe("projectTabOf", () => {
  it("reads settings and sessions, and falls back to sessions otherwise", () => {
    expect(projectTabOf("settings")).toBe("settings");
    expect(projectTabOf("sessions")).toBe("sessions");
    expect(projectTabOf(undefined)).toBe("sessions");
    expect(projectTabOf(null)).toBe("sessions");
    expect(projectTabOf("SETTINGS")).toBe("sessions");
    expect(projectTabOf("members")).toBe("sessions");
    expect(projectTabOf(["settings", "sessions"])).toBe("settings");
  });
});
