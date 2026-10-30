import { isIP } from "node:net";
import { ATTACHMENT_DEFAULT_MAX_BYTES, TITLE_TIMEOUT_MS } from "@ocw/contracts";
import { readEnvOrFile } from "@ocw/db";
import { z } from "zod";
import { createOpenBaoSecretStore, type OpenBaoConfig } from "../lib/openbao";
import {
  formatSecretUri,
  OPENBAO_SCHEME,
  type OpenBaoReference,
  parseSecretUri,
  type SecretStore,
} from "../lib/secret-store";

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
/** One proxy address: an IPv4/IPv6 address, optionally with a CIDR prefix. */
const isProxyAddress = (v: string) => {
  const [addr = "", prefix, extra] = v.split("/");
  const family = isIP(addr);
  if (!family || extra !== undefined) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
};
/**
 * Which hops may set X-Forwarded-For (SELF-05, D-18): `false` (default) ignores the header, `true` trusts every
 * hop, a number trusts that many hops (`1` behind the bundled Caddy), a comma list trusts those addresses/CIDRs.
 * It feeds `req.ip`, so the sign-in audit and rate limit. Never `true` while the API port is reachable directly.
 */
export const TrustProxy = z
  .string()
  .default("false")
  .transform((raw, ctx): boolean | number | string[] => {
    const v = raw.trim();
    if (v === "" || v === "false") return false;
    if (v === "true") return true;
    if (/^\d+$/.test(v)) return Number(v) === 0 ? false : Number(v);
    const list = v
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (list.length && list.every(isProxyAddress)) return list;
    ctx.addIssue({
      code: "custom",
      message: "must be false, true, a hop count or a comma list of proxy IPs/CIDRs",
    });
    return z.NEVER;
  });
/**
 * OCW_TRUST_PROXY in the form Fastify applies. Fastify 5.12 fails closed on a bare hop count (it trusts nothing,
 * because a hop count cannot tell the proxy from a direct client), so a count becomes the equivalent proxy-addr
 * function: trust the first `n` hops from the socket. That is only safe when the proxy is the API's only reachable
 * peer (07-08 publishes the API on 127.0.0.1 in proxy mode); otherwise configure the proxy's address or CIDR.
 */
export function fastifyTrustProxy(
  value: boolean | number | string[],
): boolean | string[] | ((address: string, hop: number) => boolean) {
  if (typeof value !== "number") return value;
  return (_address, hop) => hop < value;
}
const DEFAULT_MAIL_FROM = "Open Collaborative AI Workspace <no-reply@localhost>";

/** Loopback only: a test host must never stand in for a real private or public address. */
const isLoopback = (v: string) => {
  const family = isIP(v);
  return (family === 4 && v.startsWith("127.")) || (family === 6 && v === "::1");
};
/**
 * TEST-ONLY (D-07): `name=address,…` mapping egress test host names to a loopback address, so int and e2e tests reach
 * local fakes through the egress guard (lib/egress.ts). Refused when NODE_ENV is production.
 */
export const EgressTestHosts = z
  .string()
  .default("")
  .transform((raw, ctx): Map<string, string> => {
    const map = new Map<string, string>();
    for (const item of raw
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)) {
      const [name = "", address = "", extra] = item.split("=").map((x) => x.trim());
      if (
        extra !== undefined ||
        !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i.test(name) ||
        !isLoopback(address)
      ) {
        ctx.addIssue({ code: "custom", message: "must be a comma list of name=<loopback address>" });
        return z.NEVER;
      }
      map.set(name.toLowerCase(), address);
    }
    return map;
  });

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
    OCW_TRUST_PROXY: TrustProxy,
    /**
     * Phase 07.12-06 (D-01, PD-05): the directory holding the Local Runtime bundle (`ocw-runtime.mjs`) and its
     * `manifest.json`, served under `/api/v1/runtime/*`. The API image sets `/app/runtime-dist` (built in its own
     * stage); unset (or empty) = this checkout's `apps/local-runtime/dist` (`pnpm --filter @ocw/local-runtime
     * build:bundle`). A missing directory only makes those routes answer 404 `runtime_unavailable`.
     */
    OCW_RUNTIME_DIST_DIR: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
    /**
     * Bootstrap bearer token for the OpenClaw cell (Agent Channel API), bound to the instance's organization.
     * Written by `pnpm setup:env`; shared with the openclaw container so it starts with no manual step.
     * Admins can also mint a token in Settings › Bots runtime (stored as SHA-256 only).
     */
    OCW_CELL_TOKEN: z.string().min(32, "must be at least 32 characters").optional(),
    /**
     * Phase 07.8 (D-11, P-03): the sandbox broker as seen from the API (e.g. http://sandboxd:8090 on the internal
     * `sandbox-control` network). Empty = not configured: no bot is offered sandbox tools and every sandbox call answers
     * `service_unavailable`. The API never holds the Docker socket; it only calls this URL.
     */
    OCW_SANDBOX_URL: optionalUrl,
    /**
     * Bearer token of every sandboxd call (shared with sandboxd; `NAME` or `NAME_FILE`). Required with the URL; without
     * it the token is unused (the `sandbox` profile is off).
     */
    OCW_SANDBOX_TOKEN: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z
        .string()
        .min(32, "must be at least 32 characters")
        .optional()
        .transform((v) => v ?? null),
    ),
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
    /**
     * Optional Presidio analyzer (compose profile `pii`, MEM-05, D-06), e.g. http://presidio:3000. Empty = off: the
     * API never calls it. Memory text is sent only to this internal service and never logged.
     */
    OCW_PRESIDIO_URL: optionalUrl,
    /** Languages each text is analysed in (comma list of `es`, `en`; one request per language). */
    OCW_PRESIDIO_LANGUAGES: z
      .string()
      .default("")
      .transform((v) => v.trim() || "es,en")
      .transform((v) => [...new Set(v.split(",").map((x) => x.trim().toLowerCase()))])
      .pipe(z.array(z.enum(["es", "en"], "must be a comma list of es, en")).min(1)),
    /** Overall deadline of one Presidio scan; past it the scan reports `extended_scan_unavailable` (fail-open). */
    /**
     * OpenBao address. Read by loadConfig to resolve `openbao://` references; part of Env so the egress guard
     * refuses it as a platform host (D-07).
     */
    OCW_OPENBAO_ADDR: optionalUrl,
    /** TEST-ONLY (D-07): egress test hosts (see EgressTestHosts). Refused in production. */
    OCW_EGRESS_TEST_HOSTS: EgressTestHosts,
    OCW_PRESIDIO_TIMEOUT_MS: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.coerce.number().int().min(100).max(10_000).default(2000),
    ),
  })
  .superRefine((v, ctx) => {
    // The URL configures the sandbox broker and needs its token (07.8-05). A token alone configures nothing: `pnpm ocw
    // setup` writes it for every install, and the URL is set only with the `sandbox` compose profile (07.8-24).
    if (v.OCW_SANDBOX_URL && !v.OCW_SANDBOX_TOKEN) {
      ctx.addIssue({
        code: "custom",
        path: ["OCW_SANDBOX_TOKEN"],
        message: "is required when OCW_SANDBOX_URL is set",
      });
    }
    if (v.OCW_SMTP_URL === "memory:" && v.NODE_ENV !== "test") {
      ctx.addIssue({
        code: "custom",
        path: ["OCW_SMTP_URL"],
        message: "memory: is only allowed when NODE_ENV is test",
      });
    }
    // The ChatGPT overrides point a member's token at another server, and the egress test hosts let outbound calls
    // reach loopback: never in production (T-05-02-07, T-07.4-03-06).
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
      if (v.OCW_EGRESS_TEST_HOSTS.size > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["OCW_EGRESS_TEST_HOSTS"],
          message: "is test-only and refused when NODE_ENV is production",
        });
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
  "OCW_SANDBOX_TOKEN",
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

/**
 * The secrets only the API reads, which may therefore live in OpenBao as `openbao://<mount>/<path>#<field>` (D-16).
 * Database passwords, OCW_CELL_TOKEN and the S3 key pair are shared with other containers and stay env/file.
 */
export const OPENBAO_ALLOWED = [
  "BETTER_AUTH_SECRET",
  "OCW_ENCRYPTION_KEY",
  "OCW_SETUP_TOKEN",
  "OCW_SMTP_URL",
] as const;

export interface LoadConfigDeps {
  /** Tests inject a stub; production uses the OpenBao client. */
  createOpenBaoStore?: (cfg: OpenBaoConfig, refs: OpenBaoReference[]) => Promise<SecretStore>;
}

/** Every variable the API reads as configuration (plus the S3 secret, resolved through the SecretStore). */
const CONFIG_VARS = [
  ...new Set([...Object.keys(EnvSchema.in.shape), ...SECRET_VARS, "OCW_S3_SECRET_ACCESS_KEY"]),
];

const configError = (lines: string[]) =>
  new EnvError(`Invalid API configuration (see .env.example):\n${lines.join("\n")}`);

/**
 * Boot configuration (main.ts): resolves `openbao://` references of the four API-only secrets (after `NAME_FILE`)
 * through OpenBao, then validates everything with `loadEnv`. OpenBao is contacted only when a reference is present.
 * A reference in any other variable, a malformed one, missing OpenBao settings or an OpenBao failure is an EnvError
 * naming the variable and the reference, never a value.
 */
export async function loadConfig(
  source: NodeJS.ProcessEnv = process.env,
  deps: LoadConfigDeps = {},
): Promise<Env> {
  const allowed = new Set<string>(OPENBAO_ALLOWED);
  const problems: string[] = [];
  const refs = new Map<string, OpenBaoReference>();
  for (const name of CONFIG_VARS) {
    const value = readEnvOrFile(name, source);
    if (!value?.startsWith(OPENBAO_SCHEME)) continue;
    if (!allowed.has(name)) {
      problems.push(
        `  - ${name}: an openbao:// reference is only allowed for ${OPENBAO_ALLOWED.join(", ")}; this value is shared with other services and must stay env/file (set ${name} or ${name}_FILE)`,
      );
      continue;
    }
    const ref = parseSecretUri(value);
    if (ref?.provider !== "openbao") {
      problems.push(`  - ${name}: is not a valid openbao://<mount>/<path>#<field> reference`);
      continue;
    }
    refs.set(name, ref);
  }
  if (problems.length > 0) throw configError(problems);
  if (refs.size === 0) return loadEnv(source);

  const names = [...refs.keys()].join(", ");
  const addr = source.OCW_OPENBAO_ADDR?.trim();
  if (!addr) throw configError([`  - OCW_OPENBAO_ADDR: must be set because ${names} reference OpenBao`]);
  const cfg: OpenBaoConfig = {
    addr,
    roleId: source.OCW_OPENBAO_ROLE_ID?.trim() || undefined,
    secretId: readEnvOrFile("OCW_OPENBAO_SECRET_ID", source)?.trim() || undefined,
    token: readEnvOrFile("OCW_OPENBAO_TOKEN", source)?.trim() || undefined,
  };
  if (!(cfg.roleId && cfg.secretId) && !cfg.token) {
    throw configError([
      `  - OCW_OPENBAO_ROLE_ID: set OCW_OPENBAO_ROLE_ID and OCW_OPENBAO_SECRET_ID[_FILE] (or OCW_OPENBAO_TOKEN[_FILE]) because ${names} reference OpenBao`,
    ]);
  }

  const create = deps.createOpenBaoStore ?? createOpenBaoSecretStore;
  let store: SecretStore;
  try {
    store = await create(cfg, [...refs.values()]);
  } catch (err) {
    throw configError([`  - ${names}: ${(err as Error).message}`]);
  }
  const resolved: Record<string, string | undefined> = { ...source };
  for (const [name, ref] of refs) {
    try {
      resolved[name] = store.resolveSync(ref);
    } catch (err) {
      throw configError([`  - ${name} (${formatSecretUri(ref)}): ${(err as Error).message}`]);
    }
    delete resolved[`${name}_FILE`];
  }
  return loadEnv(resolved);
}

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
