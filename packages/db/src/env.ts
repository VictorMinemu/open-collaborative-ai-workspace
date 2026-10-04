import { readFileSync } from "node:fs";

/** Read `NAME` or the file at `NAME_FILE` (Docker secrets). Returns undefined when neither is set. */
export function readEnvOrFile(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct = env[name];
  if (direct !== undefined && direct !== "") return direct;
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, "utf8").trim();
  return undefined;
}
