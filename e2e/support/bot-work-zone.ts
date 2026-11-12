import { type APIRequestContext, type APIResponse, expect } from "@playwright/test";
import {
  type BotWorkZoneProfileInput,
  BotWorkZoneProfileView,
  DeviceBotConsentsView,
} from "../../packages/contracts/src/bot-work-zone.ts";
import { ApiError } from "../../packages/contracts/src/common.ts";
import { WorkZonePolicyView } from "../../packages/contracts/src/work-zone-policy.ts";

/**
 * Setup for the bot Work Zone specs (07.16-21) through the public API only, for the steps a spec does not exercise in
 * the browser: the organization's Work Zone policy (Full access, the bot sessions cap), a bot's Work Zone profile
 * (`PUT /api/v1/agents/:id/work-zone-profile`, the caller becomes its sponsor) and a device's consent for a bot
 * (`PUT /api/v1/devices/:id/bot-consents/:agentId`, the device's owner or an admin on a service device). Every answer is
 * parsed with its contract schema; a refusal fails with the route, the status and the error code.
 */

async function errorCode(res: APIResponse): Promise<string> {
  try {
    const body = ApiError.safeParse(await res.json());
    return body.success ? body.data.error.code : "unknown";
  } catch {
    return "unknown";
  }
}

interface Schema<T> {
  parse(data: unknown): T;
}

async function parsed<T>(what: string, res: APIResponse, schema: Schema<T>): Promise<T> {
  if (!res.ok()) throw new Error(`${what}: HTTP ${res.status()} ${await errorCode(res)}`);
  return schema.parse(await res.json());
}

/** The two policy fields the bot specs set; the rest of the organization's policy is left as it is. */
export interface BotWorkZonePolicy {
  allowFullAccess: boolean;
  botSessionsMax: number;
}

/**
 * Sets the organization's Full access switch and bot sessions cap (`PUT /api/v1/work-zone-policy`) and returns what
 * they were, so the spec can put them back in its `afterAll`.
 */
export async function setWorkZonePolicy(
  adminApi: APIRequestContext,
  policy: BotWorkZonePolicy,
): Promise<BotWorkZonePolicy> {
  const before = await parsed(
    "GET /api/v1/work-zone-policy",
    await adminApi.get("/api/v1/work-zone-policy"),
    WorkZonePolicyView,
  );
  const after = await parsed(
    "PUT /api/v1/work-zone-policy",
    await adminApi.put("/api/v1/work-zone-policy", { data: policy }),
    WorkZonePolicyView,
  );
  expect(after.allowFullAccess).toBe(policy.allowFullAccess);
  return { allowFullAccess: before.allowFullAccess, botSessionsMax: before.botSessionsMax ?? 10 };
}

/** The bot's Work Zone profile, its live status and the caller's rights (`GET /api/v1/agents/:id/work-zone-profile`). */
export async function botProfile(api: APIRequestContext, agentId: string): Promise<BotWorkZoneProfileView> {
  const path = `/api/v1/agents/${agentId}/work-zone-profile`;
  return parsed(`GET ${path}`, await api.get(path), BotWorkZoneProfileView);
}

/**
 * Saves the bot's whole Work Zone profile as `api` (who becomes its sponsor, PD-04). `opts.fileMaxBytes` sets its
 * "Largest file" (07.17.1.1 D-07: null = the organization's value); absent, `input` decides.
 */
export async function saveBotProfile(
  api: APIRequestContext,
  agentId: string,
  input: BotWorkZoneProfileInput,
  opts: { fileMaxBytes?: number | null } = {},
): Promise<BotWorkZoneProfileView> {
  const path = `/api/v1/agents/${agentId}/work-zone-profile`;
  const data: BotWorkZoneProfileInput =
    opts.fileMaxBytes === undefined ? input : { ...input, fileMaxBytes: opts.fileMaxBytes };
  const view = await parsed(`PUT ${path}`, await api.put(path, { data }), BotWorkZoneProfileView);
  if (opts.fileMaxBytes !== undefined) expect(view.profile?.fileMaxBytes ?? null).toBe(opts.fileMaxBytes);
  return view;
}

/** The device lets the bot run sessions there, with or without its own Full access checkbox (D-03, D-04). */
export async function allowBot(
  api: APIRequestContext,
  deviceId: string,
  agentId: string,
  opts: { allowFullAccess: boolean },
): Promise<DeviceBotConsentsView> {
  const path = `/api/v1/devices/${deviceId}/bot-consents/${agentId}`;
  return parsed(
    `PUT ${path}`,
    await api.put(path, { data: { allowFullAccess: opts.allowFullAccess } }),
    DeviceBotConsentsView,
  );
}

/** Waits until the bot's profile is active (saved, allowed on the device, the sponsor still allowed). */
export async function expectProfileActive(api: APIRequestContext, agentId: string): Promise<void> {
  await expect
    .poll(async () => (await botProfile(api, agentId)).status, {
      timeout: 15_000,
      message: `the Work Zone profile of ${agentId} is active`,
    })
    .toMatchObject({ active: true });
}
