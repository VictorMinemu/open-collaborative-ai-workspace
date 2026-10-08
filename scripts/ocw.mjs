#!/usr/bin/env node
// `pnpm ocw <command> [<sub>] [options]`: the operator CLI of a self-hosted install (D-03).
// Commands are files in scripts/ocw/, found by name: `ocw enable vault` runs scripts/ocw/enable-vault.mjs when it
// exists, else scripts/ocw/enable.mjs with `vault` as its first argument. Adding a command = adding a file; this
// dispatcher never changes. The first `//` line of a command file is its one-line help.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Tests point the dispatcher at a fixtures directory; operators never set this.
const COMMANDS_DIR =
  process.env.OCW_CLI_COMMANDS_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "ocw");
const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const NOT_COMMANDS = new Set(["env-file"]);

const isCommandFile = (f) =>
  f.endsWith(".mjs") && !f.endsWith(".test.mjs") && !NOT_COMMANDS.has(f.slice(0, -4));
const fileFor = (name) =>
  NAME.test(name) && !NOT_COMMANDS.has(name) ? path.join(COMMANDS_DIR, `${name}.mjs`) : null;

function summary(file) {
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((l) => /^\/\/\s*\S/.test(l));
  return line ? line.replace(/^\/\/\s*/, "") : "";
}

function help() {
  const files = existsSync(COMMANDS_DIR) ? readdirSync(COMMANDS_DIR).filter(isCommandFile).sort() : [];
  const rows = files.map((f) => [f.slice(0, -4).replace("-", " "), summary(path.join(COMMANDS_DIR, f))]);
  const width = Math.max(0, ...rows.map(([n]) => n.length));
  console.log("Usage: pnpm ocw <command> [options]\n\nCommands:");
  for (const [name, text] of rows) console.log(`  ${name.padEnd(width)}  ${text}`.trimEnd());
  console.log("\nRun `pnpm ocw <command> --help` for a command's options.");
}

const [cmd, sub, ...rest] = process.argv.slice(2);
if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
  help();
  process.exit(0);
}

let file = null;
let args = [];
const subFile = sub !== undefined ? fileFor(`${cmd}-${sub}`) : null;
if (NAME.test(cmd) && subFile && existsSync(subFile)) {
  file = subFile;
  args = rest;
} else if (fileFor(cmd) && existsSync(fileFor(cmd))) {
  file = fileFor(cmd);
  args = sub === undefined ? [] : [sub, ...rest];
}
if (!file) {
  const shown = [cmd, sub].filter((s) => s !== undefined && !s.startsWith("-")).join(" ");
  console.error(`Unknown command: ocw ${shown}. Run \`pnpm ocw help\` for the list.`);
  process.exit(2);
}

// `--` ends Node's own options: Node 24 otherwise treats a later `--env-file <path>` as its flag and exits 9 when
// that path does not exist yet (e.g. `ocw setup --env-file <new file>`).
const res = spawnSync(process.execPath, ["--", file, ...args], { stdio: "inherit" });
if (res.error) {
  console.error(res.error.message);
  process.exit(1);
}
process.exit(res.status ?? 1);
