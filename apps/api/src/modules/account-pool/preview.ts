import {
  type AccountPoolPreview,
  type AccountSourcePreview,
  POOL_PROVIDER_OF_RUNTIME,
  type RuntimeId,
  RuntimeInfo,
} from "@ocw/contracts";
import { devices, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { earliestReset } from "./select";
import { servesConsumer, usableFor } from "./selection";
import { listPoolAccounts, loadPoolPolicy } from "./store";

/**
 * What a new Work Zone session on a device would run on (Phase 07.18, D-06, D-11, PD-16, PD-19): the pool (with its
 * strategy and how many accounts are ready), the device's own login, or nothing (with the earliest reset). The same
 * `usableFor`, policy and fallback rule as `selectAccount` and `createWorkSession`, but it never writes and never
 * locks. No label, account id or token is part of the answer. The caller decides that the viewer may use the device.
 */
export async function previewAccountSources(
  tx: Tx,
  input: { deviceId: string; now: Date },
): Promise<AccountPoolPreview | null> {
  const [d] = await tx
    .select({ id: devices.id, version: devices.accountPoolVersion, runtimeInfo: devices.runtimeInfo })
    .from(devices)
    .where(eq(devices.id, input.deviceId));
  if (!d) return null;
  const runtimes = z.array(RuntimeInfo).catch([]).parse(d.runtimeInfo);
  const source = async (runtime: RuntimeId): Promise<AccountSourcePreview> => {
    // PD-04: a daemon without pool support always runs on its own login.
    if (d.version === null) return { source: "device_login" };
    const provider = POOL_PROVIDER_OF_RUNTIME[runtime];
    const policy = await loadPoolPolicy(tx, provider);
    const live = await listPoolAccounts(tx, provider);
    const ctx = { deviceId: d.id, consumer: "work_zone" as const, scope: policy.scope, now: input.now };
    const ready = live.filter((r) => usableFor(r, ctx)).length;
    if (ready > 0) return { source: "pool", strategy: policy.strategy, ready };
    const loggedIn = runtimes.find((r) => r.id === runtime)?.loggedIn === true;
    if (!policy.fallbackToDeviceLogin || (!loggedIn && live.length > 0)) {
      const reset = earliestReset(
        live
          .filter((r) => servesConsumer(r, ctx))
          .map((r) => ({ cooldownUntil: r.cooldownUntil === null ? null : new Date(r.cooldownUntil) })),
        input.now,
      );
      return { source: "none", resetsAt: reset?.toISOString() ?? null };
    }
    return { source: "device_login" };
  };
  return { "claude-code": await source("claude-code"), codex: await source("codex") };
}
