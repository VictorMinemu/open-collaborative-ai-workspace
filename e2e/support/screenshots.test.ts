import { describe, expect, it } from "vitest";
import { screenshotSpecsFromArgv, specName, writesScreenshots } from "./screenshots";

const cli = (...rest: string[]) => ["/usr/bin/node", "/repo/node_modules/.bin/playwright", "test", ...rest];

describe("specName", () => {
  it("reduces a path, a file or a filter to the spec's bare name", () => {
    expect(specName("/repo/e2e/tests/work-zone-title.spec.ts")).toBe("work-zone-title");
    expect(specName("work-zone.spec")).toBe("work-zone");
    expect(specName("work-zone.spec.ts:306")).toBe("work-zone");
    expect(specName("e2e\\tests\\setup.spec.ts")).toBe("setup");
    expect(specName("work-zone-visibility")).toBe("work-zone-visibility");
  });
});

describe("screenshotSpecsFromArgv", () => {
  it("lists the specs named on the command line, skipping options and their values", () => {
    expect(
      screenshotSpecsFromArgv(
        cli("-c", "e2e/playwright.config.ts", "work-zone-title", "work-zone.spec", "--project=mobile"),
      ),
    ).toBe("work-zone-title,work-zone");
    expect(
      screenshotSpecsFromArgv(
        cli("--config", "x.ts", "--project", "desktop", "-g", "fit", "work-zone-visibility"),
      ),
    ).toBe("work-zone-visibility");
    expect(screenshotSpecsFromArgv(cli("-u", "all", "--headed", "settings"))).toBe("settings");
  });

  it("is undefined for a run without filters (every spec writes), or outside `playwright test`", () => {
    expect(
      screenshotSpecsFromArgv(cli("-c", "e2e/playwright.config.ts", "--project=desktop")),
    ).toBeUndefined();
    expect(screenshotSpecsFromArgv(["/usr/bin/node", "/worker/process.js"])).toBeUndefined();
  });
});

describe("writesScreenshots", () => {
  const file = (name: string) => `/repo/e2e/tests/${name}.spec.ts`;

  it("writes for every spec when the run names none", () => {
    expect(writesScreenshots(file("work-zone-title"), undefined)).toBe(true);
    expect(writesScreenshots(file("setup"), undefined)).toBe(true);
    expect(writesScreenshots(file("setup"), "*")).toBe(true);
  });

  it("writes only for the specs named exactly: a filter that matches several files names none of the others", () => {
    const specs = "work-zone-visibility,work-zone";
    expect(writesScreenshots(file("work-zone-visibility"), specs)).toBe(true);
    expect(writesScreenshots(file("work-zone"), specs)).toBe(true);
    expect(writesScreenshots(file("work-zone-visibility-marker"), specs)).toBe(false);
    expect(writesScreenshots(file("work-zone-title"), specs)).toBe(false);
  });

  it("never writes the setup project's captures into a folder another spec was named for", () => {
    expect(writesScreenshots(file("setup"), "work-zone-title")).toBe(false);
    expect(writesScreenshots(file("setup"), "setup,work-zone-title")).toBe(true);
  });

  it("an empty list writes nothing", () => {
    expect(writesScreenshots(file("work-zone-title"), "")).toBe(false);
  });
});
