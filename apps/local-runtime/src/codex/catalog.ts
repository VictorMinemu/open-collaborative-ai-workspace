// Codex runtime catalog (Phase 03.2, D-08 … D-11): the models, efforts and service tiers the logged-in ChatGPT
// account really has, from `model/list` on a short-lived app-server. No thread and no turn: it costs nothing.
// Nothing here is a hard-coded model list.

import { tmpdir } from "node:os";
import {
  DEFERRED_EFFORTS,
  type PermissionMode,
  type RuntimeCatalog,
  type RuntimeModel,
} from "@ocw/contracts";
import { errorMessage } from "../logger.js";
import type { AppServerProcess, SpawnAppServer } from "./codex-runtime.js";
import type { InitializeParams } from "./generated/InitializeParams.js";
import type { Model } from "./generated/v2/Model.js";
import type { ModelListParams } from "./generated/v2/ModelListParams.js";
import type { ModelListResponse } from "./generated/v2/ModelListResponse.js";
import { JsonRpcPeer } from "./jsonrpc.js";

/** D-11: what fast mode costs on a ChatGPT login (developers.openai.com/codex/speed). */
export const CODEX_FAST_MODE_COST = "Fast uses your ChatGPT plan limits at about 2.5x the standard rate.";

/** Service tier id Codex uses for Fast. */
export const CODEX_FAST_TIER = "priority";

const MAX_PAGES = 20;
const RPC_TIMEOUT_MS = 30_000;
const MAX_MODELS = 100;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function toRuntimeModel(m: Model): RuntimeModel {
  const efforts = m.supportedReasoningEfforts
    .filter((e) => !DEFERRED_EFFORTS.includes(e.reasoningEffort)) // D-09: no `ultra`
    .slice(0, 16)
    .map((e) => ({ value: e.reasoningEffort, description: e.description ? clip(e.description, 300) : null }));
  const defaultEffort = efforts.some((e) => e.value === m.defaultReasoningEffort)
    ? m.defaultReasoningEffort
    : null;
  const fast = m.serviceTiers.some((t) => t.id === CODEX_FAST_TIER);
  return {
    id: m.id,
    displayName: clip(m.displayName || m.id, 200),
    description: m.description ? clip(m.description, 500) : null,
    legacy: m.upgrade !== null,
    isDefault: m.isDefault,
    badge: m.availabilityNux ? "new" : null, // D-08: only from the runtime
    efforts,
    defaultEffort,
    contextWindows: [], // D-10: not selectable on Codex (display only, from token usage)
    defaultContextWindow: null,
    fastMode: { supported: fast, reason: fast ? null : "not_offered" },
    supportsAutoMode: true, // approvalsReviewer auto_review is a thread setting, not per model
  };
}

/** Pure: `model/list` rows → the platform catalog. Hidden rows are never offered. */
export function buildCodexCatalog(input: {
  models: Model[];
  runtimeVersion: string | null;
  permissionModes: PermissionMode[];
  collectedAt: string;
}): RuntimeCatalog {
  return {
    runtime: "codex",
    runtimeVersion: input.runtimeVersion,
    models: input.models
      .filter((m) => !m.hidden)
      .slice(0, MAX_MODELS)
      .map(toRuntimeModel),
    permissionModes: [...input.permissionModes],
    fastModeCost: CODEX_FAST_MODE_COST,
    collectedAt: input.collectedAt,
  };
}

/**
 * `initialize` + paginated `model/list` on a short-lived app-server (experimentalApi false); never `thread/start`
 * or `turn/start`. The process is killed whatever happens.
 */
export async function listCodexModels(
  spawn: SpawnAppServer,
  opts: {
    cwd?: string;
    env: Record<string, string | undefined>;
    onRpcMessage?: (dir: "in" | "out", m: unknown) => void;
  },
): Promise<Model[]> {
  let proc: AppServerProcess | null = null;
  let peer: JsonRpcPeer | null = null;
  try {
    proc = spawn({ cwd: opts.cwd ?? tmpdir(), env: opts.env });
    proc.stderr?.resume();
    peer = new JsonRpcPeer(proc.stdout, proc.stdin, {
      onNotification: () => undefined,
      onRequest: async (r) => {
        throw new Error(`unexpected server request ${r.method}`);
      },
      ...(opts.onRpcMessage ? { onLine: opts.onRpcMessage } : {}),
    });
    const init: InitializeParams = {
      clientInfo: { name: "ocw_local_runtime", title: "Open Collaborative AI Workspace", version: "0.0.0" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    };
    await peer.request("initialize", init, RPC_TIMEOUT_MS);
    peer.notify("initialized");
    const models: Model[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params: ModelListParams = cursor ? { cursor } : {};
      const resp: ModelListResponse = await peer.request<ModelListResponse>(
        "model/list",
        params,
        RPC_TIMEOUT_MS,
      );
      models.push(...(resp.data ?? []));
      cursor = resp.nextCursor ?? null;
      if (!cursor) break;
    }
    return models;
  } finally {
    peer?.close();
    try {
      proc?.stdin.end();
      proc?.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
}

/** The catalog for the logged-in ChatGPT account (D-08 … D-11). Throws when the app-server fails. */
export async function collectCodexCatalog(
  spawn: SpawnAppServer,
  opts: {
    cwd?: string;
    env: Record<string, string | undefined>;
    runtimeVersion: string | null;
    permissionModes: PermissionMode[];
  },
): Promise<RuntimeCatalog> {
  const models = await listCodexModels(spawn, {
    env: opts.env,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  }).catch((err: unknown) => {
    throw new Error(`codex model/list failed: ${errorMessage(err)}`);
  });
  return buildCodexCatalog({
    models,
    runtimeVersion: opts.runtimeVersion,
    permissionModes: opts.permissionModes,
    collectedAt: new Date().toISOString(),
  });
}
