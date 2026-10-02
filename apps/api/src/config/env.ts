import { readEnvOrFile } from "@ocw/db";
import { z } from "zod";

/**
 * API configuration. Every secret accepts `NAME` or `NAME_FILE` (Docker secrets). Boot fails fast with a
 * message naming the missing/invalid variable. Nothing is generated at boot.
 */
const Url = z.url();

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** ocw_app role (RLS enforced). */
  DATABASE_URL: Url,
  /** ocw_auth role (schema auth only). */
  AUTH_DATABASE_URL: Url,
  REDIS_URL: Url,
  BETTER_AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
  OCW_SETUP_TOKEN: z.string().min(16, "must be at least 16 characters"),
  /** 32-byte key, base64 or hex, for AES-256-GCM encryption of app.secrets. */
  OCW_ENCRYPTION_KEY: z
    .string()
    .refine((v) => decodeKey(v) !== null, "must be 32 bytes as base64 or 64 hex chars"),
  OCW_PUBLIC_WEB_URL: Url.default("http://localhost:3000"),
  OCW_PUBLIC_API_URL: Url.default("http://localhost:4000"),
  /** Extra allowed browser origins (comma-separated), e.g. a LAN URL for the demo. */
  OCW_TRUSTED_ORIGINS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
});
export type Env = z.infer<typeof EnvSchema>;

const SECRET_VARS = [
  "DATABASE_URL",
  "AUTH_DATABASE_URL",
  "REDIS_URL",
  "BETTER_AUTH_SECRET",
  "OCW_SETUP_TOKEN",
  "OCW_ENCRYPTION_KEY",
] as const;

export function decodeKey(v: string): Buffer | null {
  const s = v.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  try {
    const b = Buffer.from(s, "base64");
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

export class EnvError extends Error {}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const raw: Record<string, string | undefined> = { ...source };
  for (const name of SECRET_VARS) raw[name] = readEnvOrFile(name, source);
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => {
      const name = String(i.path[0] ?? "?");
      const hint = (SECRET_VARS as readonly string[]).includes(name) ? ` (set ${name} or ${name}_FILE)` : "";
      return `  - ${name}: ${i.message}${hint}`;
    });
    throw new EnvError(`Invalid API configuration (see .env.example):\n${lines.join("\n")}`);
  }
  return parsed.data;
}
