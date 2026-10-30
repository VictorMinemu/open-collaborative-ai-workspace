import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Logger } from "./logger.js";
import { applyServiceEnv, readServiceEnv, SERVICE_ENV_FILE } from "./service-env.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A scratch user home with `<userHome>/.ocw` as OCW_HOME, so messages read `~/.ocw/service.env`. */
function scratch(): { userHome: string; home: string } {
  const userHome = realpathSync(mkdtempSync(join(tmpdir(), "ocw-senv-")));
  dirs.push(userHome);
  const home = join(userHome, ".ocw");
  mkdirSync(home, { mode: 0o700 });
  return { userHome, home };
}

const SAMPLE = [
  "# note",
  "",
  'CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat-x"',
  "FOO=bar baz",
  "lower=1",
  "OCW_HOME=/x",
  "NOVALUE",
  "SINGLE='quoted value'",
  "EMPTY=",
].join("\n");

function write(home: string, text: string, mode: number): void {
  const file = join(home, SERVICE_ENV_FILE);
  writeFileSync(file, text, { mode });
  chmodSync(file, mode);
}

function capture(): {
  log: Logger;
  lines: Array<{ level: string; msg: string; meta?: Record<string, unknown> }>;
} {
  const lines: Array<{ level: string; msg: string; meta?: Record<string, unknown> }> = [];
  const at =
    (level: string) =>
    (msg: string, meta?: Record<string, unknown>): void => {
      lines.push({ level, msg, ...(meta ? { meta } : {}) });
    };
  return { log: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") }, lines };
}

describe("readServiceEnv (07.12, D-12, PD-10)", () => {
  it("no file: absent, nothing read", async () => {
    const { home } = scratch();
    expect(await readServiceEnv(home)).toEqual({
      summary: { status: "absent", keys: [], invalidLines: 0 },
      values: {},
    });
  });

  it("a 0600 file: NAME=value pairs, comments and blanks skipped, quotes stripped, OCW_HOME never taken", async () => {
    const { home } = scratch();
    write(home, SAMPLE, 0o600);
    const { summary, values } = await readServiceEnv(home);
    expect(summary).toEqual({
      status: "loaded",
      keys: ["CLAUDE_CODE_OAUTH_TOKEN", "EMPTY", "FOO", "SINGLE"],
      invalidLines: 3,
    });
    expect(values).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-x",
      FOO: "bar baz",
      SINGLE: "quoted value",
      EMPTY: "",
    });
  });

  it("CRLF line endings and no expansion", async () => {
    const { home } = scratch();
    write(home, "A=$HOME\r\nB=x\r\n", 0o600);
    expect((await readServiceEnv(home)).values).toEqual({ A: "$HOME", B: "x" });
  });

  it.each([0o640, 0o604, 0o660, 0o644])("mode %o: refused_mode, no values", async (mode) => {
    const { home } = scratch();
    write(home, SAMPLE, mode);
    expect(await readServiceEnv(home)).toEqual({
      summary: { status: "refused_mode", keys: [], invalidLines: 0 },
      values: {},
    });
  });

  it("owned by another user: refused_owner, no values", async () => {
    const { home } = scratch();
    write(home, SAMPLE, 0o600);
    const uid = process.getuid?.() ?? 0;
    const result = await readServiceEnv(home, { stat: async () => ({ mode: 0o100600, uid: uid + 1 }) });
    expect(result).toEqual({ summary: { status: "refused_owner", keys: [], invalidLines: 0 }, values: {} });
  });
});

describe("applyServiceEnv (07.12, D-12, PD-10)", () => {
  it("sets only the keys the environment lacks and logs names only", async () => {
    const { home, userHome } = scratch();
    write(home, SAMPLE, 0o600);
    const env: NodeJS.ProcessEnv = { FOO: "from-env" };
    const { log, lines } = capture();
    const summary = await applyServiceEnv(home, env, log, { userHome });
    expect(summary.status).toBe("loaded");
    expect(env).toEqual({
      FOO: "from-env",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-x",
      SINGLE: "quoted value",
      EMPTY: "",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("info");
    const logged = JSON.stringify(lines);
    expect(logged).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(logged).toContain("~/.ocw/service.env");
    for (const value of ["sk-ant-oat-x", "bar baz", "quoted value", "from-env"])
      expect(logged).not.toContain(value);
  });

  it("refused: one error line with the chmod fix, nothing set, no value logged", async () => {
    const { home, userHome } = scratch();
    write(home, SAMPLE, 0o644);
    const env: NodeJS.ProcessEnv = {};
    const { log, lines } = capture();
    const summary = await applyServiceEnv(home, env, log, { userHome });
    expect(summary.status).toBe("refused_mode");
    expect(env).toEqual({});
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("error");
    expect(lines[0]?.msg).toContain("chmod 600 ~/.ocw/service.env");
    expect(JSON.stringify(lines)).not.toContain("sk-ant-oat-x");

    const owner = capture();
    const uid = process.getuid?.() ?? 0;
    write(home, SAMPLE, 0o600);
    await applyServiceEnv(home, env, owner.log, {
      userHome,
      stat: async () => ({ mode: 0o100600, uid: uid + 1 }),
    });
    expect(env).toEqual({});
    expect(owner.lines).toHaveLength(1);
    expect(owner.lines[0]?.level).toBe("error");
    expect(owner.lines[0]?.msg).toContain("chmod 600 ~/.ocw/service.env");
  });

  it("absent: nothing set and nothing logged above debug", async () => {
    const { home } = scratch();
    const env: NodeJS.ProcessEnv = {};
    const { log, lines } = capture();
    expect(await applyServiceEnv(home, env, log)).toEqual({ status: "absent", keys: [], invalidLines: 0 });
    expect(env).toEqual({});
    expect(lines.filter((l) => l.level !== "debug")).toEqual([]);
  });
});
