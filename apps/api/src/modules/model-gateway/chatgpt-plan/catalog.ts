import { z } from "zod";
import type { Core } from "../../../core";
import { ModelUnavailableError } from "../errors";
import { type CredentialRow, catalogCacheKey } from "./credentials";

/**
 * The member's ChatGPT plan model catalog: `GET {OCW_CHATGPT_API_BASE_URL}/models` with the member's own token,
 * `visibility: "list"` models only, cached in Redis for an hour per credential (`ocw:ai:catalog:<credentialId>`).
 */
export interface PlanModel {
  slug: string;
  label: string;
}

const CACHE_TTL_SECONDS = 3_600;
const FETCH_TIMEOUT_MS = 10_000;
export const DEFAULT_CHATGPT_API_BASE_URL = "https://api.openai.com/v1";

/** Tolerant: `slug ?? id`, `display_name ?? slug`, `visibility` defaults to "list"; unknown fields ignored. */
const CatalogResponse = z.object({
  data: z.array(
    z
      .object({
        slug: z.string().min(1).max(200).optional(),
        id: z.string().min(1).max(200).optional(),
        display_name: z.string().min(1).max(200).optional(),
        visibility: z.string().optional(),
      })
      .loose(),
  ),
});

export function parsePlanCatalog(json: unknown): PlanModel[] {
  const parsed = CatalogResponse.safeParse(json);
  if (!parsed.success) return [];
  const out: PlanModel[] = [];
  for (const m of parsed.data.data) {
    const slug = m.slug ?? m.id;
    if (!slug || (m.visibility ?? "list") !== "list") continue;
    if (out.some((x) => x.slug === slug)) continue;
    out.push({ slug, label: m.display_name ?? slug });
  }
  return out;
}

/** The catalog could not be read for a reason other than the token (network, 5xx): callers degrade. */
export class CatalogUnavailableError extends Error {
  constructor(readonly status: number | null) {
    super("ChatGPT plan catalog unavailable");
  }
}

/** The cached catalog only (no token needed): what the picker shows while the plan's auth server is out. */
export async function cachedPlanCatalog(core: Core, credentialId: string): Promise<PlanModel[] | null> {
  const cached = await core.bus.pub.get(catalogCacheKey(credentialId)).catch(() => null);
  if (!cached) return null;
  try {
    return z.array(z.object({ slug: z.string(), label: z.string() })).parse(JSON.parse(cached));
  } catch {
    return null;
  }
}

export async function planCatalog(
  core: Core,
  credential: CredentialRow,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<PlanModel[]> {
  const key = catalogCacheKey(credential.id);
  const cached = await core.bus.pub.get(key).catch(() => null);
  if (cached) {
    try {
      return z.array(z.object({ slug: z.string(), label: z.string() })).parse(JSON.parse(cached));
    } catch {
      /* refetch */
    }
  }
  const base = core.env.OCW_CHATGPT_API_BASE_URL ?? DEFAULT_CHATGPT_API_BASE_URL;
  let res: Response;
  try {
    res = await fetchImpl(`${base.replace(/\/+$/u, "")}/models`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new CatalogUnavailableError(null);
  }
  if (res.status === 401 || res.status === 403) throw new ModelUnavailableError("needs_reconnect");
  if (!res.ok) throw new CatalogUnavailableError(res.status);
  const models = parsePlanCatalog(await res.json().catch(() => null));
  await core.bus.pub.set(key, JSON.stringify(models), { EX: CACHE_TTL_SECONDS }).catch(() => null);
  return models;
}
