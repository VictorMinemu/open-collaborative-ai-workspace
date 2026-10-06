import { ATTACHMENT_DEFAULT_MAX_BYTES, TITLE_TIMEOUT_MS } from "@ocw/contracts";
import { readEnvOrFile } from "@ocw/db";
import { z } from "zod";

/**
 * API configuration. Every secret accepts `NAME` or `NAME_FILE` (Docker secrets). Boot fails fast with a
 * message naming the missing/invalid variable. Nothing is generated at boot.
 */
const Url = z.url();
/** Sign-in attempts per IP per minute; production default 30 (credential-stuffing brake). */
export const SignInRatePerMinute = z.coerce.number().int().min(1).max(10_000).default(30);
/** Empty and unset are the same (compose passes `${VAR:-}`). */
const optionalUrl = z
  .union([z.literal(""), Url])
  .optional()
  .transform((v) => v || null);
const withDefault = (fallback: string) =>
  z
    .string()
    .default("")
    .transform((v) => v.trim() || fallback);
/** Per-file attachment limit in bytes: default 25 MiB, at most 1 GiB. */
export const AttachmentMaxBytes = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z.coerce
    .number()
    .int()
    .positive()
    .max(1024 ** 3, "must be at most 1 GiB (1073741824)")
    .default(ATTACHMENT_DEFAULT_MAX_BYTES),
);
const DEFAULT_MAIL_FROM = "Open Collaborative AI Workspace <no-reply@localhost>";

export const EnvSchema = z
  .object({
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
    /**
     * Bootstrap bearer token for the OpenClaw cell (Agent Channel API), bound to the instance's organization.
     * Written by `pnpm setup:env`; shared with the openclaw container so it starts with no manual step.
     * Admins can also mint a token in Settings › Bots runtime (stored as SHA-256 only).
     */
    OCW_CELL_TOKEN: z.string().min(32, "must be at least 32 characters").optional(),
    /** `mock` offers the deterministic fake model (`fake/mock-1`) for E2E/CI; never metered. */
    OCW_MODEL_PROVIDER: z
      .enum(["", "mock"])
      .default("")
      .transform((v) => (v === "" ? null : v)),
    /** Base URL of the fake OpenAI-compatible model server as seen from the OpenClaw container. */
    OCW_MOCK_MODEL_BASE_URL: Url.default("http://fake-model:18999/v1"),
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
    /**
     * Optional SMTP server for password reset e-mails (smtp:// or smtps://, credentials in the URL, so it is a
     * secret). Without it admins issue reset links instead. `memory:` is a test-only outbox.
     */
    /**
     * Sign-in attempts per IP per minute (credential-stuffing brake). Keep the default in production;
     * only test harnesses that sign many browsers in from one IP raise it.
     */
    OCW_SIGNIN_RATE_LIMIT_PER_MINUTE: SignInRatePerMinute,
    /**
     * Search requests per user per minute, shared by every /search route (P-11). Keep the default in
     * production; only test harnesses that drive many searches as one user raise it.
     */
    OCW_SEARCH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(30),
    OCW_SMTP_URL: z
      .string()
      .regex(/^(smtps?:\/\/\S+|memory:)$/, "must be an smtp:// or smtps:// URL")
      .optional(),
    /** Sender of platform e-mails. */
    OCW_MAIL_FROM: z
      .string()
      .default("")
      .transform((v) => v.trim() || DEFAULT_MAIL_FROM),
    /**
     * Accept the raw device token on the Device Link (`/runtime/ws`) from desktop apps built before Phase 2,
     * which do not exchange it for a device JWT first (D-03). Every use is warned and audited
     * (`device.legacy_token_used`, at most once per device per hour). Removed in Phase 8 together with the
     * raw device token (RFC 8628 device grant).
     */
    /**
     * Base URL of the optional SearXNG instance (compose profile `search`, D-09), as seen from the cell. Set for
     * both the API and the cell; without it admins cannot pick `searxng` as the web search provider.
     */
    OCW_SEARXNG_URL: z
      .union([z.literal(""), Url])
      .optional()
      .transform((v) => v || null),
    /**
     * Web search plugins bundled in the cell image (mirrors the cell's variable): comma list, `none` = nothing
     * bundled. Internet is `configured` only when the chosen provider is bundled or installed (D-06, D-09).
     */
    OCW_BUNDLED_PLUGINS: z
      .string()
      .default("duckduckgo,searxng")
      .transform((s) =>
        s.trim().toLowerCase() === "none"
          ? []
          : s
              .split(",")
              .map((x) => x.trim().toLowerCase())
              .filter(Boolean),
      ),
    /**
     * Base URL of the optional stdio MCP sandbox sidecar (`ocw-mcp-sandbox`, D-13), as seen from the cell. Without
     * it admins cannot register `sandboxed-stdio` servers; the sidecar serves each vetted server at
     * `<url>/<server>/mcp` (streamable HTTP).
     */
    OCW_MCP_SANDBOX_URL: z
      .union([z.literal(""), Url])
      .optional()
      .transform((v) => v || null),
    /** Vetted stdio servers baked into the sandbox image (comma list, e.g. `everything`). */
    OCW_MCP_SANDBOX_SERVERS: z
      .string()
      .default("")
      .transform((s) =>
        s
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "server names are lowercase [a-z0-9_-]"))),
    /**
     * OpenClaw Marketplace registry (ClawHub, D-14) the API proxies for Settings › Marketplace, and the only origin
     * approved artifacts are downloaded from. Point it at the fake ClawHub (fake-model `/api/v1/*`) in tests.
     */
    OCW_CLAWHUB_URL: Url.default("https://clawhub.ai"),
    /**
     * S3-compatible object storage for chat attachments (Garage in compose, ADR-0015, P-10). Storage is configured
     * only when the endpoint, the key id and the secret (`OCW_S3_SECRET_ACCESS_KEY` or `_FILE`, resolved through the
     * SecretStore and never part of Env) are all present; otherwise attachments report `enabled: false`.
     * `OCW_S3_ENDPOINT` serves server operations (e.g. http://garage:3900); `OCW_S3_PUBLIC_URL` is the origin the
     * browser reaches and the only one presigned URLs are signed for (SigV4 signs the Host); it defaults to the
     * endpoint.
     */
    OCW_S3_ENDPOINT: optionalUrl,
    OCW_S3_PUBLIC_URL: optionalUrl,
    OCW_S3_BUCKET: withDefault("ocw-attachments"),
    OCW_S3_REGION: withDefault("garage"),
    OCW_S3_ACCESS_KEY_ID: z
      .string()
      .default("")
      .transform((v) => v.trim() || null),
    OCW_ATTACHMENT_MAX_BYTES: AttachmentMaxBytes,
    OCW_ACCEPT_LEGACY_DEVICE_TOKEN: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    /**
     * TEST-ONLY (P-12): the OpenAI API the ChatGPT-plan backend calls (`/responses`, `/models`). Unset = the real
     * https://api.openai.com/v1. Refused when NODE_ENV is production.
     */
    OCW_CHATGPT_API_BASE_URL: optionalUrl,
    /** TEST-ONLY (P-12): the ChatGPT sign-in issuer (05-05). Unset = https://auth.openai.com. Refused in production. */
    OCW_CHATGPT_AUTH_BASE_URL: optionalUrl,
    /** The fake model as seen from the API (mock AI chat backend, 05-04); defaults to OCW_MOCK_MODEL_BASE_URL. */
    OCW_AI_MOCK_BASE_URL: optionalUrl,
    /** SearXNG as seen from the API (AI chat web search on org keys, 05-11); defaults to OCW_SEARXNG_URL. */
    OCW_AI_SEARXNG_URL: optionalUrl,
    /** AI chat sends per user per minute (create + message). Keep the default in production. */
    OCW_AI_SEND_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(30),
    /** Deadline of one AI chat title call (05-10, ADR-0014: 20 s); tests shorten it. */
    OCW_AI_TITLE_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(TITLE_TIMEOUT_MS),
  })
  .superRefine((v, ctx) => {
    if (v.OCW_SMTP_URL === "memory:" && v.NODE_ENV !== "test") {
      ctx.addIssue({
        code: "custom",
        path: ["OCW_SMTP_URL"],
        message: "memory: is only allowed when NODE_ENV is test",
      });
    }
    // The ChatGPT overrides point a member's token at another server: never in production (T-05-02-07).
    if (v.NODE_ENV === "production") {
      for (const name of ["OCW_CHATGPT_API_BASE_URL", "OCW_CHATGPT_AUTH_BASE_URL"] as const) {
        if (v[name]) {
          ctx.addIssue({
            code: "custom",
            path: [name],
            message: "is test-only and refused when NODE_ENV is production",
          });
        }
      }
    }
  })
  .transform((v) => ({
    ...v,
    OCW_S3_PUBLIC_URL: v.OCW_S3_PUBLIC_URL ?? v.OCW_S3_ENDPOINT,
    OCW_AI_MOCK_BASE_URL: v.OCW_AI_MOCK_BASE_URL ?? v.OCW_MOCK_MODEL_BASE_URL,
    OCW_AI_SEARXNG_URL: v.OCW_AI_SEARXNG_URL ?? v.OCW_SEARXNG_URL,
  }));
export type Env = z.infer<typeof EnvSchema>;

const SECRET_VARS = [
  "DATABASE_URL",
  "AUTH_DATABASE_URL",
  "REDIS_URL",
  "BETTER_AUTH_SECRET",
  "OCW_SETUP_TOKEN",
  "OCW_ENCRYPTION_KEY",
  "OCW_CELL_TOKEN",
  "OCW_SMTP_URL",
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
