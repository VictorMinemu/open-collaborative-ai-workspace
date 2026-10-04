import type { SubscriptionProviderId } from "./agent-channel-protocol.js";
import type { EventStreamLogger } from "./event-stream.js";
import type { PluginRuntimeLike } from "./openclaw-port.js";
import type { SubscriptionAccount, SubscriptionAuthDriver } from "./subscription-auth.js";

/**
 * Subscription sign-in backed by OpenClaw itself (ADR-0006). OpenClaw 2026.9.7 implements ChatGPT/Codex
 * device-code login in its bundled `openai` provider plugin (auth method `device-code`: auth.openai.com
 * user code → poll → token exchange) and stores the resulting OAuth profile (`openai:<email>`) in its
 * auth store, refreshing it on use. We drive the very same flow its channel `/login` command and Control
 * UI use (`runModelsAuthLoginFlow`), with a prompter that hands the code to the OCW web UI instead of a
 * terminal. Verified on a real 2026.9.7 gateway (code issued by auth.openai.com).
 */

const TARGET: Record<SubscriptionProviderId, { provider: string; method: string; ownerPluginId: string }> = {
  "openai-codex": { provider: "openai", method: "device-code", ownerPluginId: "openai" },
};

/**
 * Agent whose auth store receives the credential. `main` is OpenClaw's shared-main agent: its sign-ins go
 * to the shared store that every `ocw-*` bot agent reads through (no per-bot copies of refresh tokens).
 */
export const AUTH_AGENT_ID = "main";

const LOGIN_FLOW_MODULE = "openclaw/plugin-sdk/provider-auth-login-flow-runtime";
const PROVIDER_AUTH_MODULE = "openclaw/plugin-sdk/provider-auth";

type StoredCredential = Record<string, unknown> & {
  type?: string;
  provider?: string;
  email?: string;
  chatgptPlanType?: string;
  access?: string;
  refresh?: string;
};

/** `openai:owner@example.com` → `owner@example.com`. */
export function emailFromProfileId(profileId: string): string | null {
  const rest = profileId.slice(profileId.indexOf(":") + 1);
  return rest.includes("@") ? rest : null;
}

/** First usable OAuth credential of `provider` in an auth store snapshot (pure; unit-tested). */
export function accountFromStore(
  store: { profiles?: Record<string, StoredCredential> } | undefined,
  provider: string,
): SubscriptionAccount | null {
  for (const [id, cred] of Object.entries(store?.profiles ?? {})) {
    if (cred?.provider !== provider || cred.type !== "oauth") continue;
    if (!cred.refresh && !cred.access) continue;
    return {
      email: typeof cred.email === "string" && cred.email ? cred.email : emailFromProfileId(id),
      planType: typeof cred.chatgptPlanType === "string" ? cred.chatgptPlanType : null,
    };
  }
  return null;
}

export function createOpenClawAuthDriver(opts: {
  runtime: PluginRuntimeLike;
  log?: EventStreamLogger;
  /** Test seam: module loader (defaults to dynamic import of the OpenClaw SDK subpaths). */
  load?: (specifier: string) => Promise<unknown>;
}): SubscriptionAuthDriver {
  const { runtime } = opts;
  // Literal specifiers: OpenClaw's plugin loader only aliases `openclaw/plugin-sdk/*` it can see statically.
  const load =
    opts.load ??
    ((specifier: string) =>
      specifier === LOGIN_FLOW_MODULE
        ? import("openclaw/plugin-sdk/provider-auth-login-flow-runtime")
        : import("openclaw/plugin-sdk/provider-auth"));
  const loginFlow = () =>
    load(LOGIN_FLOW_MODULE) as Promise<typeof import("openclaw/plugin-sdk/provider-auth-login-flow-runtime")>;

  function readStore() {
    if (!runtime.modelAuth) throw new Error("OpenClaw runtime has no modelAuth (needs >= 2026.9.7)");
    return runtime.modelAuth.ensureAuthProfileStore(undefined, {
      readOnly: true,
      allowKeychainPrompt: false,
    });
  }

  async function refreshGateway(): Promise<void> {
    const flow = await loginFlow();
    await flow.refreshProviderLoginAuthState({
      agentId: AUTH_AGENT_ID,
      readConfig: () => runtime.config.current(),
      assertCurrent: () => {},
    });
  }

  const driver: SubscriptionAuthDriver = {
    async login({ provider, signal, onDeviceCode }) {
      const target = TARGET[provider];
      const flow = await loginFlow();
      let verificationUrl: string | null = null;
      const quiet = async () => {};
      const unsupported = async (): Promise<never> => {
        throw new Error("interactive prompts are not available in the OCW cell");
      };
      const result = await flow.runModelsAuthLoginFlow({
        provider: target.provider,
        method: target.method,
        ownerPluginId: target.ownerPluginId,
        credentialOnly: true,
        agent: AUTH_AGENT_ID,
        config: runtime.config.current(),
        // OpenClaw's own progress/notes would echo the URL; the code goes ONLY through onDeviceCode.
        runtime: {
          log: () => {},
          error: () => {},
          exit: (code: number): never => {
            throw new Error(`sign-in exited with status ${code}`);
          },
        },
        prompter: {
          intro: quiet,
          outro: quiet,
          note: quiet,
          plain: quiet,
          async deviceCode({ code, expiresInMinutes }) {
            signal.throwIfAborted();
            if (!verificationUrl) throw new Error("OpenClaw issued a device code without a verification URL");
            await onDeviceCode({ verificationUrl, userCode: code, expiresInMs: expiresInMinutes * 60_000 });
          },
          // Only reachable for the post-save model-access question; OCW pins each bot's model itself.
          select: async (p) => p.options.find((o) => o.value === "keep")?.value ?? unsupported(),
          multiselect: unsupported,
          text: unsupported,
          confirm: async () => false,
          progress: () => ({ update: () => {}, stop: () => {} }),
        },
        signal,
        // Remote: the code is shown elsewhere (the OCW web UI); OpenClaw hands us the URL first.
        isRemote: true,
        openUrl: async (url) => {
          verificationUrl = url;
        },
        assertCurrent: () => signal.throwIfAborted(),
        beforePersistentEffect: () => signal.throwIfAborted(),
        onModelAccessRequested: () => {},
        refreshAfterLogin: (agentId) =>
          flow.refreshProviderLoginAuthState({
            agentId,
            readConfig: () => runtime.config.current(),
            assertCurrent: () => {},
          }),
      });
      const profile = result.profiles.find((p) => p.mode === "oauth") ?? result.profiles[0];
      if (!profile) throw new Error("the sign-in returned no credential");
      if (result.authRefresh !== "refreshed") {
        opts.log?.warn?.(`sign-in saved but the gateway refresh reported ${result.authRefresh}`);
      }
      const stored = accountFromStore(readStore() as never, target.provider);
      return stored ?? { email: emailFromProfileId(profile.profileId), planType: null };
    },

    async status(provider) {
      return accountFromStore(readStore() as never, TARGET[provider].provider);
    },

    async logout(provider) {
      const target = TARGET[provider];
      const auth = (await load(PROVIDER_AUTH_MODULE)) as typeof import("openclaw/plugin-sdk/provider-auth");
      await auth.removeProviderAuthProfilesWithLock({
        cfg: runtime.config.current(),
        provider: target.provider,
      });
      await refreshGateway().catch((error: unknown) => {
        opts.log?.warn?.(
          `auth refresh after sign-out failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      if (accountFromStore(readStore() as never, target.provider)) {
        throw new Error("the auth store is busy; the credential is still present");
      }
    },
  };
  return driver;
}
