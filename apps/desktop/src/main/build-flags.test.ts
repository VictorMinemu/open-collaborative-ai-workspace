// The release-build flag (07.13.1, D-02): nothing defines `__OCW_RELEASE_BUILD__` under vitest, as in a local
// `pnpm package` or a fork's build, so the updater can never turn on there.
import { describe, expect, it } from "vitest";
import { RELEASE_BUILD } from "./build-flags";

describe("RELEASE_BUILD", () => {
  it("is false when no release build defined it", () => {
    expect(RELEASE_BUILD).toBe(false);
  });
});
