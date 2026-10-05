import { createHash } from "node:crypto";
import type { DeclaredSurface, PluginChannel } from "@ocw/contracts";
import { z } from "zod";
import type { RedisBus } from "../../lib/redis";
import { canonicalSurface } from "./risk";

/**
 * ClawHub proxy client (D-14, research B2 / P-B6). GET-only, anonymous, telemetry-free: every request carries a
 * fixed user agent and nothing that identifies the organization or the user (no cookies, no authorization, no
 * ids in the URL beyond the package, version and search terms). Responses are parsed leniently (unknown fields
 * ignored, wrong-typed optional fields dropped) and cached: fresh for 10 minutes, kept for a day as a fallback
 * while ClawHub is unreachable. Approvals read live (`live: true`) and never accept stale data.
 *
 * Paths: `/api/v1/packages/search` (text search), `/api/v1/plugins` (browse) and
 * `/api/v1/packages/{name}/detail?version=` — the single request OpenClaw 2026.9.5+ itself uses for a release's
 * package, owner, versions, manifest summary, verification, artifact and security trust (the per-version
 * endpoints time out on the live service).
 */

export const CLAWHUB_TIMEOUT_MS = 8000;
export const CLAWHUB_USER_AGENT = "ocw-marketplace-proxy";
export const CLAWHUB_FRESH_SECONDS = 600;
export const CLAWHUB_KEEP_SECONDS = 86_400;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface ClawhubCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/** Shared Redis cache (ClawHub metadata is public: one cache for every organization). Errors = cache miss. */
export function redisClawhubCache(bus: RedisBus): ClawhubCache {
  return {
    async get(key) {
      return bus.pub.get(key).catch(() => null);
    },
    async set(key, value, ttlSeconds) {
      await bus.pub.set(key, value, { expiration: { type: "EX", value: ttlSeconds } }).catch(() => {});
    },
  };
}

export type MarketplaceUnavailableReason = "timeout" | "unavailable" | "network" | "malformed";

/** ClawHub could not answer (timeout, 5xx / rate limit, network, unreadable body). Routes map it to 503. */
export class MarketplaceUnavailableError extends Error {
  constructor(
    readonly reason: MarketplaceUnavailableReason,
    message: string,
  ) {
    super(message);
    this.name = "MarketplaceUnavailableError";
  }
}

/** ClawHub answered 404 for the package or version. */
export class MarketplaceNotFoundError extends Error {
  constructor(message = "Package or version not found on ClawHub") {
    super(message);
    this.name = "MarketplaceNotFoundError";
  }
}

export interface ClawhubPackage {
  packageName: string;
  displayName: string;
  summary: string | null;
  publisher: string;
  publisherOfficial: boolean;
  channel: PluginChannel;
  latestVersion: string;
  downloads: number;
  installs: number;
  stars: number;
  scanStatus: string | null;
  verificationTier: string | null;
  /** The OpenClaw plugin id the package installs (`duckduckgo`). */
  runtimeId: string | null;
}

export interface ClawhubVersionDetail {
  package: ClawhubPackage;
  version: string;
  publishedAt: string | null;
  versions: { version: string; publishedAt: string | null }[];
  verification: {
    tier: string | null;
    hasProvenance: boolean;
    sourceRepo: string | null;
    sourceCommit: string | null;
  };
  scan: {
    status: string | null;
    blockedFromDownload: boolean;
    pending: boolean;
    reasons: string[];
    moderationState: string | null;
  };
  compatibility: { minGatewayVersion: string | null; pluginApiRange: string | null };
  artifact: { sha256: string; npmIntegrity: string | null; size: number | null };
  declared: DeclaredSurface;
}

export interface ClawhubClient {
  readonly baseUrl: string;
  readonly origin: string;
  search(
    q: string,
    opts: { limit: number; cursor?: string },
  ): Promise<{ packages: ClawhubPackage[]; nextCursor: string | null; source: "live" | "cache" }>;
  versionDetail(
    name: string,
    version?: string,
    opts?: { live?: boolean },
  ): Promise<{ detail: ClawhubVersionDetail; source: "live" | "cache" }>;
  /** Download URL of a release's npm-pack artifact, always on the configured origin. */
  artifactUrl(name: string, version: string): string;
}

// ---------------------------------------------------------------- lenient parsing

const str = z.string().nullish().catch(null);
const bool = z.boolean().nullish().catch(null);
const num = z.number().nonnegative().nullish().catch(null);
const record = z.record(z.string(), z.unknown()).nullish().catch(null);

const RawPackage = z.object({
  name: z.string().min(1),
  displayName: str,
  family: str,
  channel: str,
  isOfficial: bool,
  ownerHandle: str,
  ownerOfficial: bool,
  runtimeId: str,
  latestVersion: str,
  summary: str,
  scanStatus: str,
  verificationTier: str,
  stats: z.object({ downloads: num, installs: num, stars: num }).nullish().catch(null),
  tags: record,
  compatibility: record,
  verification: record,
  artifact: record,
});
type RawPackage = z.infer<typeof RawPackage>;

const RawSearch = z.object({ results: z.array(z.object({ package: z.unknown() })) });
const RawBrowse = z.object({ items: z.array(z.unknown()), nextCursor: str });
const RawDetail = z.object({
  package: RawPackage,
  owner: z.object({ handle: str, official: bool }).nullish().catch(null),
  versions: z
    .object({ items: z.array(z.unknown()) })
    .nullish()
    .catch(null),
  version: record,
  security: record,
});

const PLUGIN_FAMILIES = new Set(["code-plugin", "bundle-plugin"]);

function isoOf(v: unknown): string | null {
  if (typeof v !== "number" && typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const s = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const rec = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
/** `["a", {name: "b"}, {id: "c"}]` → `["a", "b", "c"]`. */
const names = (v: unknown, key: "name" | "id" | "path" = "name"): string[] =>
  Array.isArray(v)
    ? v.flatMap((x) => {
        if (typeof x === "string" && x) return [x];
        const r = rec(x);
        const n = r ? (s(r[key]) ?? s(r.name) ?? s(r.id)) : null;
        return n ? [n] : [];
      })
    : [];

function toPackage(
  raw: RawPackage,
  owner?: { handle?: string | null; official?: boolean | null } | null,
): ClawhubPackage | null {
  if (raw.family && !PLUGIN_FAMILIES.has(raw.family)) return null;
  const latestVersion = raw.latestVersion ?? s(raw.tags?.latest);
  if (!latestVersion) return null;
  return {
    packageName: raw.name,
    displayName: raw.displayName ?? raw.name,
    summary: raw.summary ?? null,
    publisher: raw.ownerHandle ?? owner?.handle ?? "unknown",
    publisherOfficial: raw.ownerOfficial ?? owner?.official ?? raw.isOfficial ?? false,
    channel: raw.channel === "official" ? "official" : "community",
    latestVersion,
    downloads: Math.floor(raw.stats?.downloads ?? 0),
    installs: Math.floor(raw.stats?.installs ?? 0),
    stars: Math.floor(raw.stats?.stars ?? 0),
    scanStatus: raw.scanStatus ?? null,
    verificationTier: raw.verificationTier ?? s(raw.verification?.tier),
    runtimeId: raw.runtimeId ?? null,
  };
}

const parsePackage = (v: unknown) => {
  const r = RawPackage.safeParse(v);
  return r.success ? toPackage(r.data) : null;
};

/** Contract families mapped to their own DeclaredSurface lists. */
const OWN_CONTRACTS = new Set(["tools", "webSearchProviders", "webFetchProviders"]);

/** ClawHub's `pluginManifestSummary` → our DeclaredSurface (canonical: deduplicated, sorted). */
export function declaredSurfaceOf(manifest: unknown): DeclaredSurface {
  const m = rec(manifest);
  if (!m) {
    return canonicalSurface({
      tools: [],
      hooks: [],
      channels: [],
      providers: [],
      webSearchProviders: [],
      webFetchProviders: [],
      mcpServers: [],
      other: ["manifest:missing"],
    });
  }
  const contracts = rec(m.contracts) ?? {};
  const other: string[] = [];
  for (const [family, ids] of Object.entries(contracts)) {
    if (OWN_CONTRACTS.has(family)) continue;
    const list = strings(ids);
    // A family with no ids still declares the capability.
    for (const id of list.length > 0 ? list : [""]) other.push(`${family}:${id}`);
  }
  for (const n of names(m.bundledSkills)) other.push(`skills:${n}`);
  for (const n of names(m.skills)) other.push(`skills:${n}`);
  for (const n of names(m.cliBackends)) other.push(`cliBackends:${n}`);
  for (const n of names(m.cliCommands)) other.push(`cliCommands:${n}`);
  for (const n of names(m.httpRoutes, "path")) other.push(`httpRoutes:${n}`);
  for (const n of names(m.gatewayMethods)) other.push(`gatewayMethodDispatch:${n}`);
  for (const n of [...strings(m.kind), ...(s(m.kind) ? [m.kind as string] : [])]) other.push(`kind:${n}`);
  for (const n of names(m.contextEngines)) other.push(`contextEngines:${n}`);
  const dangerous = rec(m.configContracts)?.dangerousFlags ?? m.dangerousConfigFlags;
  for (const n of names(dangerous, "path")) other.push(`dangerousConfigFlags:${n}`);
  const channel = rec(m.channel);
  return canonicalSurface({
    tools: [...strings(contracts.tools), ...Object.keys(rec(m.toolMetadata) ?? {})],
    hooks: names(m.hooks),
    channels: [...names(m.channels, "id"), ...(channel && s(channel.id) ? [channel.id as string] : [])],
    providers: names(m.providers, "id"),
    webSearchProviders: strings(contracts.webSearchProviders),
    webFetchProviders: strings(contracts.webFetchProviders),
    mcpServers: names(m.mcpServers),
    other,
  });
}

function toDetail(raw: z.infer<typeof RawDetail>, wanted: string | undefined): ClawhubVersionDetail {
  const pkg = toPackage(raw.package, raw.owner);
  if (!pkg) throw new MarketplaceNotFoundError("Not an installable OpenClaw plugin package");
  const v = raw.version;
  const versionName = s(v?.version) ?? wanted ?? pkg.latestVersion;
  if (!v || (wanted && versionName !== wanted))
    throw new MarketplaceNotFoundError("Version not found on ClawHub");
  const isLatest = versionName === pkg.latestVersion;

  const verification = rec(v.verification) ?? (isLatest ? raw.package.verification : null) ?? {};
  const artifact = rec(v.artifact) ?? (isLatest ? raw.package.artifact : null) ?? {};
  const manifest = rec(v.pluginManifestSummary);
  const compatibility =
    rec(v.compatibility) ??
    rec(manifest?.compatibility) ??
    (isLatest ? raw.package.compatibility : null) ??
    {};
  const trust = rec(raw.security?.trust);
  const scanStatus =
    s(trust?.scanStatus) ??
    s(verification.scanStatus) ??
    (isLatest ? (raw.package.scanStatus ?? null) : null);

  const sha = s(artifact.sha256)?.toLowerCase() ?? "";
  return {
    package: pkg,
    version: versionName,
    publishedAt: isoOf(v.createdAt),
    versions: (raw.versions?.items ?? []).flatMap((item) => {
      const x = rec(item);
      const name = s(x?.version);
      return name ? [{ version: name, publishedAt: isoOf(x?.createdAt) }] : [];
    }),
    verification: {
      tier: s(verification.tier),
      hasProvenance: verification.hasProvenance === true,
      sourceRepo: s(verification.sourceRepo),
      sourceCommit: s(verification.sourceCommit),
    },
    scan: {
      status: scanStatus,
      blockedFromDownload: trust?.blockedFromDownload === true,
      // No trust record at all: we cannot tell whether a scan finished.
      pending: trust ? trust.pending === true : scanStatus === null,
      reasons: strings(trust?.reasons).slice(0, 20),
      moderationState: s(trust?.moderationState),
    },
    compatibility: {
      minGatewayVersion: s(compatibility.minGatewayVersion),
      pluginApiRange: s(compatibility.pluginApiRange),
    },
    artifact: {
      sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : "",
      npmIntegrity: s(artifact.npmIntegrity),
      size: typeof artifact.size === "number" && Number.isSafeInteger(artifact.size) ? artifact.size : null,
    },
    declared: declaredSurfaceOf(manifest),
  };
}

// ---------------------------------------------------------------- client

export function createClawhubClient(deps: {
  baseUrl: string;
  bus?: RedisBus;
  cache?: ClawhubCache;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): ClawhubClient {
  const base = new URL(deps.baseUrl);
  const origin = base.origin;
  const prefix = base.pathname.replace(/\/+$/, "");
  const timeoutMs = deps.timeoutMs ?? CLAWHUB_TIMEOUT_MS;
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const cache: ClawhubCache | null = deps.cache ?? (deps.bus ? redisClawhubCache(deps.bus) : null);

  const urlOf = (path: string, query: Record<string, string | undefined> = {}) => {
    const u = new URL(`${origin}${prefix}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") u.searchParams.set(k, v);
    return u;
  };

  async function fetchJson(url: URL): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "GET",
        headers: { "user-agent": CLAWHUB_USER_AGENT, accept: "application/json" },
        credentials: "omit",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new MarketplaceUnavailableError("timeout", "ClawHub did not answer in time");
      }
      throw new MarketplaceUnavailableError("network", "ClawHub is unreachable");
    }
    let text: string;
    try {
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {});
        throw new MarketplaceNotFoundError();
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new MarketplaceUnavailableError("unavailable", `ClawHub answered ${res.status}`);
      }
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > MAX_BODY_BYTES)
        throw new MarketplaceUnavailableError("malformed", "ClawHub answer too large");
      text = await res.text();
    } catch (error) {
      if (error instanceof MarketplaceNotFoundError || error instanceof MarketplaceUnavailableError)
        throw error;
      const name = (error as { name?: string })?.name;
      throw new MarketplaceUnavailableError(
        name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
        "ClawHub answer interrupted",
      );
    }
    if (text.length > MAX_BODY_BYTES)
      throw new MarketplaceUnavailableError("malformed", "ClawHub answer too large");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new MarketplaceUnavailableError("malformed", "ClawHub answered something that is not JSON");
    }
  }

  /** Cached GET + parse. The parsed value is cached, so a malformed answer is never stored. */
  async function get<T>(
    url: URL,
    parse: (body: unknown) => T,
    live: boolean,
  ): Promise<{ value: T; source: "live" | "cache" }> {
    const key = `ocw:clawhub:${createHash("sha256").update(url.toString()).digest("hex").slice(0, 40)}`;
    let cached: { at: number; value: T } | null = null;
    if (cache && !live) {
      const raw = await cache.get(key).catch(() => null);
      if (raw) {
        try {
          cached = JSON.parse(raw) as { at: number; value: T };
        } catch {
          cached = null;
        }
      }
      if (cached && now() - cached.at < CLAWHUB_FRESH_SECONDS * 1000)
        return { value: cached.value, source: "cache" };
    }
    try {
      const value = parse(await fetchJson(url));
      await cache?.set(key, JSON.stringify({ at: now(), value }), CLAWHUB_KEEP_SECONDS).catch(() => {});
      return { value, source: "live" };
    } catch (error) {
      // Outage: serve the last good copy rather than nothing (never for approvals).
      if (error instanceof MarketplaceUnavailableError && cached)
        return { value: cached.value, source: "cache" };
      throw error;
    }
  }

  return {
    baseUrl: `${origin}${prefix}`,
    origin,

    async search(q, opts) {
      const query = q.trim();
      if (query) {
        const url = urlOf("/api/v1/packages/search", {
          q: query,
          family: "code-plugin",
          limit: String(opts.limit),
        });
        const { value, source } = await get(
          url,
          (body) => {
            const parsed = RawSearch.safeParse(body);
            if (!parsed.success)
              throw new MarketplaceUnavailableError("malformed", "Unexpected ClawHub search answer");
            return parsed.data.results.map((r) => parsePackage(r.package)).filter((p) => p !== null);
          },
          false,
        );
        return { packages: value, nextCursor: null, source };
      }
      const url = urlOf("/api/v1/plugins", {
        limit: String(opts.limit),
        cursor: opts.cursor,
        sort: "downloads",
      });
      const { value, source } = await get(
        url,
        (body) => {
          const parsed = RawBrowse.safeParse(body);
          if (!parsed.success)
            throw new MarketplaceUnavailableError("malformed", "Unexpected ClawHub catalog answer");
          return {
            packages: parsed.data.items.map(parsePackage).filter((p) => p !== null),
            nextCursor: parsed.data.nextCursor ?? null,
          };
        },
        false,
      );
      return { ...value, source };
    },

    async versionDetail(name, version, opts = {}) {
      const url = urlOf(`/api/v1/packages/${encodeURIComponent(name)}/detail`, { version });
      const { value, source } = await get(
        url,
        (body) => {
          const parsed = RawDetail.safeParse(body);
          if (!parsed.success)
            throw new MarketplaceUnavailableError("malformed", "Unexpected ClawHub package answer");
          return toDetail(parsed.data, version);
        },
        opts.live === true,
      );
      return { detail: value, source };
    },

    artifactUrl(name, version) {
      return urlOf(
        `/api/v1/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/artifact/download`,
      ).toString();
    },
  };
}
