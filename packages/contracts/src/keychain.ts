import { z } from "zod";
import { Id, IsoDateTime } from "./common";
import { McpHeaderName } from "./mcp";

/**
 * Agent keychain (Phase 07.4, D-04; CONN-05). A vault item is a personal or unit secret (an API key, a username and
 * password, or an OAuth client-credentials pair) that a bot uses BY HANDLE through `ocw_http_request`: the API injects
 * the secret into the request, and only towards the item's allowed hosts. The model, the cell, logs and audit rows see
 * the handle, never the value (principle 8). Storage goes through the secret store (`SecretReference`), sealed with AAD
 * `${org}:vault:${itemId}`.
 *
 * Secret material is WRITE-ONLY: create and update requests take it, `VaultItem` only says `hasValue`.
 */

export const VaultScope = z.enum(["personal", "unit"]);
export type VaultScope = z.infer<typeof VaultScope>;

export const VaultKind = z.enum(["api_key", "basic", "oauth"]);
export type VaultKind = z.infer<typeof VaultKind>;

/** The stable, non-secret name a bot uses: `k_` + 10 base32 characters, unique per organization. */
export const VaultHandle = z.string().regex(/^k_[a-z2-7]{10}$/, "invalid key handle");
export type VaultHandle = z.infer<typeof VaultHandle>;

export const VAULT_LIMITS = {
  nameChars: 80,
  hosts: 16,
  hostChars: 253,
  pathPrefixChars: 512,
  agents: 64,
  privateHosts: 64,
  apiKeyChars: 8192,
} as const;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DNS_NAME = `${LABEL}(?:\\.${LABEL})*`;
const PORT_RE = /^(?:[1-9]\d{0,4})$/;
const HOST_PATTERN_RE = new RegExp(`^(\\*\\.)?(${DNS_NAME})(?::(\\d{1,5}))?$`);
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Parsed form of a host pattern, or null when it is not one. */
function parseHostPattern(raw: string): { wildcard: boolean; host: string; port: number | null } | null {
  if (raw.length === 0 || raw.length > VAULT_LIMITS.hostChars) return null;
  const m = HOST_PATTERN_RE.exec(raw);
  if (!m) return null;
  const wildcard = m[1] !== undefined;
  const host = m[2] ?? "";
  const portText = m[3];
  let port: number | null = null;
  if (portText !== undefined) {
    if (!PORT_RE.test(portText)) return null;
    port = Number(portText);
    if (port < 1 || port > 65_535) return null;
  }
  const numeric = IPV4_RE.test(host);
  if (numeric && host.split(".").some((o) => Number(o) > 255)) return null;
  // A wildcard needs a registrable-looking name: never an IP literal, never a bare top-level label.
  if (wildcard && (numeric || !host.includes("."))) return null;
  return { wildcard, host, port };
}

/**
 * Where a key may be sent: a lower-case DNS name (`api.example.com`), a wildcard over its subdomains
 * (`*.example.com`, not the apex) or an IPv4 literal, each with an optional `:port`. No scheme, no path, no IP-literal
 * wildcard, at most 253 characters. Input is trimmed and lower-cased.
 */
export const VaultHostPattern = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => parseHostPattern(v) !== null, { message: "a host like api.example.com or *.example.com" });
export type VaultHostPattern = z.infer<typeof VaultHostPattern>;

/** A private-network host an admin allows for keychain requests (no wildcard). */
export const PrivateHost = VaultHostPattern.refine((v) => !v.startsWith("*."), {
  message: "a single host, without a wildcard",
});
export type PrivateHost = z.infer<typeof PrivateHost>;

/**
 * True when `url` (http or https) may receive a key with these allowed hosts: the host equals a pattern's host, or is
 * a strict subdomain of a wildcard's; a pattern with a port matches only that port, one without a port only the
 * scheme's default port. Credentials in the URL never match. The API re-checks after DNS resolution through its egress guard.
 */
export function vaultHostAllowed(patterns: readonly string[], url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  const defaultPort = u.protocol === "https:" ? 443 : 80;
  const port = u.port === "" ? defaultPort : Number(u.port);
  return patterns.some((raw) => {
    const p = parseHostPattern(raw.trim().toLowerCase());
    if (!p) return false;
    if ((p.port ?? defaultPort) !== port) return false;
    return p.wildcard ? host.endsWith(`.${p.host}`) : host === p.host;
  });
}

// ---------------------------------------------------------------- injection

/** Headers a key may never be injected into (request smuggling, cookies, host routing), plus every `proxy-*` name. */
export const FORBIDDEN_INJECTION_HEADERS = [
  "cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
] as const;

/** True for a valid header name that a secret may be injected into (case-insensitive). */
export function isAllowedInjectionHeader(name: string): boolean {
  if (!McpHeaderName.safeParse(name).success) return false;
  const lower = name.toLowerCase();
  return !(FORBIDDEN_INJECTION_HEADERS as readonly string[]).includes(lower) && !lower.startsWith("proxy-");
}

export const VaultInjectionScheme = z.enum(["bearer", "basic", "raw"]);
export type VaultInjectionScheme = z.infer<typeof VaultInjectionScheme>;

/** How the API puts the secret into a request: `Authorization: Bearer <key>` by default. */
export const VaultInjection = z.object({
  header: McpHeaderName.refine(isAllowedInjectionHeader, {
    message: "this header cannot carry a key",
  }).default("Authorization"),
  scheme: VaultInjectionScheme.default("bearer"),
});
export type VaultInjection = z.infer<typeof VaultInjection>;

const BASIC_INJECTION: VaultInjection = { header: "Authorization", scheme: "basic" };

/** A path the key is limited to (`/v2/`): absolute, no `..`, no query or fragment. */
export const VaultPathPrefix = z
  .string()
  .trim()
  .max(VAULT_LIMITS.pathPrefixChars)
  .refine((p) => p.startsWith("/") && !/[?#\s]/.test(p) && !p.split("/").includes(".."), {
    message: "a path such as /v2/",
  });

const VaultName = z.string().trim().min(1).max(VAULT_LIMITS.nameChars);
const AllowedHosts = z.array(VaultHostPattern).min(1).max(VAULT_LIMITS.hosts);
const HttpsUrl = z
  .url()
  .max(2000)
  .refine((u) => u.startsWith("https://"), { message: "must be https" });

// ---------------------------------------------------------------- items (responses carry no secret)

export const VaultItem = z.object({
  id: Id,
  scope: VaultScope,
  /** Unit items: the unit (null = the whole organization). Personal items: null. */
  unitId: Id.nullable(),
  /** Personal items: the owner. Unit items: null. */
  ownerUserId: Id.nullable(),
  name: z.string().min(1).max(VAULT_LIMITS.nameChars),
  handle: VaultHandle,
  kind: VaultKind,
  injection: VaultInjection,
  allowedHosts: z.array(z.string()).min(1).max(VAULT_LIMITS.hosts),
  allowedPathPrefix: z.string().nullable(),
  /** `oauth`: the token endpoint (not secret). */
  tokenUrl: z.string().nullable(),
  hasValue: z.literal(true),
  /** When the secret value was set or last replaced; an edit of hosts or name does not change it (R3). */
  valueUpdatedAt: IsoDateTime,
  /** Bots granted this key. */
  agentIds: z.array(Id),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastUsedAt: IsoDateTime.nullable(),
});
export type VaultItem = z.infer<typeof VaultItem>;

/** `GET /api/v1/keychain`. The private-host list has its own route (`/keychain/private-hosts`, R5). */
export const VaultItemList = z.object({
  personal: z.array(VaultItem),
  unit: z.array(VaultItem),
  /** Where the caller may manage unit keys (`vault.manage`); `unitId` null = the organization. */
  manageableUnits: z.array(z.object({ unitId: Id.nullable(), name: z.string() })),
});
export type VaultItemList = z.infer<typeof VaultItemList>;

// ---------------------------------------------------------------- requests (secret material is write-only)

/** Secret material per kind; on update it replaces the stored value. */
export const VaultApiKeySecret = z.object({ value: z.string().min(1).max(VAULT_LIMITS.apiKeyChars) });
export const VaultBasicSecret = z.object({
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(1024),
});
export const VaultOAuthSecret = z.object({
  clientId: z.string().trim().min(1).max(256),
  clientSecret: z.string().min(1).max(4096),
  scope: z.string().trim().max(1000).optional(),
});

const createCommon = {
  scope: VaultScope,
  unitId: Id.nullable().optional(),
  name: VaultName,
  injection: VaultInjection.optional(),
  allowedHosts: AllowedHosts,
  allowedPathPrefix: VaultPathPrefix.optional(),
};

/**
 * `POST /api/v1/keychain`. Personal items take no `unitId`; unit items name one (null = the organization). `basic`
 * always injects `Authorization: Basic …`; the other kinds inject `Authorization: Bearer …` unless told otherwise
 * (`raw` sends the value as is). An OAuth token URL is https and on an allowed host.
 */
export const CreateVaultItemRequest = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("api_key"), ...createCommon, ...VaultApiKeySecret.shape }),
    z.object({ kind: z.literal("basic"), ...createCommon, ...VaultBasicSecret.shape }),
    z.object({ kind: z.literal("oauth"), ...createCommon, tokenUrl: HttpsUrl, ...VaultOAuthSecret.shape }),
  ])
  .superRefine((v, ctx) => {
    if (v.scope === "personal" && v.unitId != null) {
      ctx.addIssue({ code: "custom", path: ["unitId"], message: "a personal key belongs to no unit" });
    }
    if (v.kind !== "basic" && v.injection?.scheme === "basic") {
      ctx.addIssue({
        code: "custom",
        path: ["injection", "scheme"],
        message: "only a username and password key is Basic",
      });
    }
    if (v.kind === "oauth" && !vaultHostAllowed(v.allowedHosts, v.tokenUrl)) {
      ctx.addIssue({
        code: "custom",
        path: ["tokenUrl"],
        message: "the token URL's host must be an allowed host",
      });
    }
  })
  .transform((v) => ({
    ...v,
    injection: v.kind === "basic" ? BASIC_INJECTION : (v.injection ?? VaultInjection.parse({})),
  }));
export type CreateVaultItemRequest = z.infer<typeof CreateVaultItemRequest>;

/**
 * `PATCH /api/v1/keychain/:id`: any subset; `secret`, when present, replaces the stored value and must be of the
 * item's kind (the API checks). Kind and scope never change.
 */
export const UpdateVaultItemRequest = z.object({
  name: VaultName.optional(),
  injection: VaultInjection.optional(),
  allowedHosts: AllowedHosts.optional(),
  allowedPathPrefix: VaultPathPrefix.nullable().optional(),
  tokenUrl: HttpsUrl.optional(),
  secret: z
    .discriminatedUnion("kind", [
      VaultApiKeySecret.extend({ kind: z.literal("api_key") }),
      VaultBasicSecret.extend({ kind: z.literal("basic") }),
      VaultOAuthSecret.extend({ kind: z.literal("oauth") }),
    ])
    .optional(),
});
export type UpdateVaultItemRequest = z.infer<typeof UpdateVaultItemRequest>;

/** `PUT /api/v1/keychain/:id/agents`: the bots that may use the key (each still decided per turn). */
export const SetVaultItemAgentsRequest = z.object({ agentIds: z.array(Id).max(VAULT_LIMITS.agents) });
export type SetVaultItemAgentsRequest = z.infer<typeof SetVaultItemAgentsRequest>;

/** `GET|PUT /api/v1/keychain/private-hosts`: private-network hosts keychain requests may reach (org policy, R5). */
export const PrivateHostsSettings = z.object({ hosts: z.array(PrivateHost).max(VAULT_LIMITS.privateHosts) });
export type PrivateHostsSettings = z.infer<typeof PrivateHostsSettings>;

/** A key the turn's bot may use, as `ocw_connector_list` shows it: never the value. */
export const AgentVaultKey = z.object({
  handle: VaultHandle,
  name: z.string(),
  allowedHosts: z.array(z.string()).max(VAULT_LIMITS.hosts),
});
export type AgentVaultKey = z.infer<typeof AgentVaultKey>;
