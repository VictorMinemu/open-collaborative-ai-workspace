import { describe, expect, it } from "vitest";
import { isCi, superuserUrl } from "./superuser";

const ISOLATED = "postgres://postgres:pw@localhost:5432/ocw_e2e";
const CI_URL = "postgres://postgres:pw@localhost:5432/ocw";
const noDotEnv = () => undefined;
const dotEnvWith = (value: string) => (name: string) =>
  name === "MIGRATE_SUPERUSER_URL" ? value : undefined;

describe("isCi", () => {
  it("recognises Woodpecker (CI=woodpecker, CI_PIPELINE_NUMBER) and GitHub Actions (GITHUB_ACTIONS=true)", () => {
    expect(isCi({ CI: "woodpecker" })).toBe(true);
    expect(isCi({ CI_PIPELINE_NUMBER: "33" })).toBe(true);
    expect(isCi({ CI: "true", GITHUB_ACTIONS: "true" })).toBe(true);
  });

  it("is false on a developer machine", () => {
    expect(isCi({})).toBe(false);
    expect(isCi({ CI: "" })).toBe(false);
    expect(isCi({ CI: "false" })).toBe(false);
    expect(isCi({ CI: "0" })).toBe(false);
    // A bare CI=true (e.g. `CI=true pnpm e2e` on a Mac) is not a runner.
    expect(isCi({ CI: "true" })).toBe(false);
    expect(isCi({ WOODPECKER: "true" })).toBe(false);
  });
});

describe("superuserUrl", () => {
  it("accepts the isolated runner's ocw_e2e, in or out of CI", () => {
    expect(superuserUrl({ MIGRATE_SUPERUSER_URL: ISOLATED }, noDotEnv)).toBe(ISOLATED);
    expect(superuserUrl({ MIGRATE_SUPERUSER_URL: `${ISOLATED}?sslmode=disable` }, noDotEnv)).toBe(
      `${ISOLATED}?sslmode=disable`,
    );
    expect(superuserUrl({ CI: "true", MIGRATE_SUPERUSER_URL: ISOLATED }, noDotEnv)).toBe(ISOLATED);
  });

  it("accepts CI's ephemeral loopback ocw, from the environment or the .env setup:env wrote", () => {
    expect(superuserUrl({ CI: "woodpecker", MIGRATE_SUPERUSER_URL: CI_URL }, noDotEnv)).toBe(CI_URL);
    expect(superuserUrl({ CI: "woodpecker", CI_PIPELINE_NUMBER: "33" }, dotEnvWith(CI_URL))).toBe(CI_URL);
    expect(
      superuserUrl(
        { CI: "true", GITHUB_ACTIONS: "true" },
        dotEnvWith("postgresql://postgres:pw@127.0.0.1:5432/ocw"),
      ),
    ).toBe("postgresql://postgres:pw@127.0.0.1:5432/ocw");
  });

  it("refuses the demo's ocw on a developer machine, from the environment or the .env", () => {
    expect(() => superuserUrl({ MIGRATE_SUPERUSER_URL: CI_URL }, noDotEnv)).toThrow(
      /database "ocw" outside CI/,
    );
    // Outside CI the .env (the demo's) is never read.
    expect(() => superuserUrl({}, dotEnvWith(CI_URL))).toThrow(/not set/);
    expect(() => superuserUrl({ CI: "false" }, dotEnvWith(CI_URL))).toThrow(/not set/);
  });

  it("refuses any other database or host, even in CI", () => {
    expect(() =>
      superuserUrl(
        { CI: "woodpecker", MIGRATE_SUPERUSER_URL: "postgres://postgres:pw@localhost:5432/prod" },
        noDotEnv,
      ),
    ).toThrow(/database "prod" in CI/);
    expect(() =>
      superuserUrl(
        { CI: "woodpecker", MIGRATE_SUPERUSER_URL: "postgres://postgres:pw@db.example.com:5432/ocw" },
        noDotEnv,
      ),
    ).toThrow(/non-loopback host/);
    expect(() =>
      superuserUrl({ MIGRATE_SUPERUSER_URL: "postgres://postgres:pw@localhost:5432/ocw_e2e_old" }, noDotEnv),
    ).toThrow(/database "ocw_e2e_old"/);
    expect(() =>
      superuserUrl({ CI: "true", MIGRATE_SUPERUSER_URL: "mysql://root@localhost/ocw" }, noDotEnv),
    ).toThrow(/not a postgres URL/);
    expect(() => superuserUrl({ CI: "true", MIGRATE_SUPERUSER_URL: "not a url" }, noDotEnv)).toThrow(
      /not a URL/,
    );
    expect(() => superuserUrl({ CI: "true" }, noDotEnv)).toThrow(/not set/);
  });

  it("never puts the URL (it holds a password) in the error", () => {
    expect(() =>
      superuserUrl({ MIGRATE_SUPERUSER_URL: "postgres://postgres:s3cret-pw@localhost:5432/ocw" }, noDotEnv),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining("s3cret-pw") }));
  });
});
