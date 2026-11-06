import {
  AuthTestStep,
  type ConnectorAuthFailure,
  type ConnectorErrorCode,
  type ConnectorOAuthClientMethod,
  type ConnectorOAuthUrls,
  type OAuthTestMode,
  type OAuthTestResponse,
} from "@ocw/contracts";
import type { Egress } from "../../lib/egress";
import {
  type ClientPreviewOptions,
  ConnectorOAuthError,
  clientCredentialsGrant,
  type DiscoveredAuth,
  discover,
  discoverTokenEndpoint,
  isTrustedEndpoint,
  previewClient,
  type TokenEndpointDiscovery,
} from "./oauth";

/**
 * Sign-in diagnosis (07.14 D-10, D-18): which step of an organization sign-in, a client-credentials grant or a Test
 * sign-in failed, as one of the eight `ConnectorAuthFailure` codes in their fixed order (public URL → discovery →
 * issuer → endpoints → PKCE → client registration → token). The answer is always a closed code: provider error
 * bodies, `error_description` and SDK messages are never read into a code, a step or a response. Member flows keep
 * their 07.4 `ConnectorErrorCode` unchanged (COA-05); only the organization paths and the Test sign-in read these.
 *
 * `diagnose()` is the Test sign-in: a dry run that never registers a client at the provider (the client choice is
 * `previewClient`, which sends nothing) and never stores or logs anything. For client credentials it makes one real
 * grant and drops the token at once: the only way to surface `scope_rejected` or `token_exchange_failed`.
 */

/** The D-10 code of a 07.4 code, for an error whose throw site named no step. */
const FROM_CODE: Partial<Record<ConnectorErrorCode, ConnectorAuthFailure>> = {
  https_required: "https_required",
  discovery_failed: "discovery_failed",
  pkce_unsupported: "pkce_unsupported",
  issuer_mismatch: "issuer_mismatch",
  token_exchange_failed: "token_exchange_failed",
  needs_client: "client_registration_unavailable",
  egress_refused: "token_endpoint_untrusted",
};

/**
 * The D-10 failure an error stands for: its `step` when the throw site set one, else derived from its code; anything
 * that is not a `ConnectorOAuthError` (or a code with no D-10 meaning) is `token_exchange_failed`. Pure: no I/O, and
 * the error's message is never read.
 */
export function authFailureOf(err: unknown): ConnectorAuthFailure {
  if (!(err instanceof ConnectorOAuthError)) return "token_exchange_failed";
  return err.step ?? FROM_CODE[err.code] ?? "token_exchange_failed";
}

// ---------------------------------------------------------------- diagnose

/** What a Test sign-in checks: the form's (or the saved server's) values, loaded by the route (09). */
export interface DiagnoseInput {
  serverUrl: string;
  mode: OAuthTestMode;
  urls: ConnectorOAuthUrls;
  preRegistered: ClientPreviewOptions["preRegistered"];
  storedClients: ClientPreviewOptions["stored"];
  allowCimd: boolean;
  /** Client credentials: the scopes to request (empty = none sent). */
  scopes: string[];
  /**
   * Client credentials only. `tokenEndpoint`: the admin's Token URL, used when the server publishes no metadata.
   * `pin`: set when the secret is the stored one (not typed in the form): it is sent only to the saved issuer's saved
   * token endpoint; a discovery that now names another issuer or endpoint fails before any token request.
   */
  cc?: {
    /** Missing (none typed, none usable): the token step fails with nothing sent. */
    clientId?: string;
    clientSecret?: string;
    tokenEndpoint?: string;
    pin?: { issuer: string | null; tokenEndpoint: string };
  };
  /** The origin the admin opened the page on (RESEARCH Pitfall 1). */
  pageOrigin?: string;
}

/** The step each failure is reported at. */
const STEP_OF: Readonly<Record<ConnectorAuthFailure, AuthTestStep>> = {
  https_required: "public_url",
  discovery_failed: "discovery",
  issuer_mismatch: "issuer",
  token_endpoint_untrusted: "endpoints",
  pkce_unsupported: "pkce",
  client_registration_unavailable: "client_registration",
  scope_rejected: "token",
  token_exchange_failed: "token",
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * PD-08 `public_url`: the instance has a redirect URI a provider accepts (https, or loopback http), and a loopback one
 * only when the admin is on a loopback page too: behind a tunnel or proxy the provider would send the browser to the
 * admin's own machine (`OCW_PUBLIC_API_URL` left at its default).
 */
function publicUrlOk(urls: ConnectorOAuthUrls, pageOrigin: string | undefined): boolean {
  if (!urls.oauthAvailable || !urls.redirectUri) return false;
  if (!pageOrigin) return true;
  let redirectHost: string;
  let pageHost: string;
  try {
    redirectHost = new URL(urls.redirectUri).hostname;
    pageHost = new URL(pageOrigin).hostname;
  } catch {
    return true;
  }
  return !(LOOPBACK_HOSTS.has(redirectHost) && !LOOPBACK_HOSTS.has(pageHost));
}

type StepStatus = OAuthTestResponse["steps"][number]["status"];

/**
 * The Test sign-in (PD-08): runs the steps in order and stops at the first failure, which is reported with its D-10
 * code; every step after it (and every step the mode does not have) is `skipped`. Sign-in modes check the public URL,
 * discovery (issuer, endpoints, PKCE through `discover`) and the client choice (`previewClient`, never a
 * registration); client credentials check discovery (`discoverTokenEndpoint`, else the admin's Token URL, required
 * then), the endpoint and a real grant whose token is discarded. Writes nothing; the answer carries no token, secret
 * or provider text.
 */
export async function diagnose(egress: Egress, input: DiagnoseInput): Promise<OAuthTestResponse> {
  const status = new Map<AuthTestStep, StepStatus>();
  let failure: ConnectorAuthFailure | null = null;
  let clientMethod: ConnectorOAuthClientMethod | null = null;
  let issuer: string | null = null;
  let tokenEndpoint: string | null = null;

  const pass = (...steps: AuthTestStep[]) => {
    for (const s of steps) if (!status.has(s)) status.set(s, "ok");
  };
  /** The failure at its own step when that step belongs to `phase`, else at the phase's first step. */
  const fail = (phase: readonly AuthTestStep[], f: ConnectorAuthFailure) => {
    const at = phase.includes(STEP_OF[f]) ? STEP_OF[f] : (phase[0] ?? STEP_OF[f]);
    for (const s of phase) {
      if (s === at) break;
      pass(s);
    }
    status.set(at, "failed");
    failure = f;
  };
  const answer = (): OAuthTestResponse => ({
    ok: failure === null,
    failure,
    steps: AuthTestStep.options.map((step) => ({ step, status: status.get(step) ?? "skipped" })),
    clientMethod,
    issuer,
    tokenEndpoint,
    redirectUri: input.urls.redirectUri,
    clientMetadataUrl: input.urls.clientMetadataUrl,
  });

  if (input.mode !== "org_client_credentials") {
    if (!publicUrlOk(input.urls, input.pageOrigin)) {
      fail(["public_url"], "https_required");
      return answer();
    }
    pass("public_url");
    let d: DiscoveredAuth;
    try {
      d = await discover(egress, input.serverUrl);
    } catch (err) {
      fail(["discovery", "issuer", "endpoints", "pkce"], authFailureOf(err));
      return answer();
    }
    issuer = d.issuer;
    tokenEndpoint = d.metadata.token_endpoint;
    pass("discovery", "issuer", "endpoints", "pkce");
    try {
      clientMethod = previewClient(d, {
        preRegistered: input.preRegistered,
        stored: input.storedClients,
        urls: input.urls,
        allowCimd: input.allowCimd,
      }).method;
    } catch (err) {
      fail(["client_registration"], authFailureOf(err));
      return answer();
    }
    pass("client_registration");
    return answer();
  }

  let disc: TokenEndpointDiscovery;
  try {
    disc = await discoverTokenEndpoint(egress, input.serverUrl);
  } catch (err) {
    fail(["discovery", "issuer", "endpoints"], authFailureOf(err));
    return answer();
  }
  const endpoint = disc.tokenEndpoint ?? input.cc?.tokenEndpoint ?? null;
  if (endpoint === null) {
    // No metadata and no Token URL: nothing to sign in against.
    fail(["discovery"], "discovery_failed");
    return answer();
  }
  pass("discovery");
  // A stored secret never follows a changed issuer or token endpoint (write-only secrets: it is not readable back).
  const pin = input.cc?.pin;
  if (pin && disc.issuer !== pin.issuer) {
    fail(["issuer"], "issuer_mismatch");
    return answer();
  }
  if (pin && endpoint !== pin.tokenEndpoint) {
    if (disc.issuer !== null) pass("issuer");
    fail(["endpoints"], "token_endpoint_untrusted");
    return answer();
  }
  // Without metadata there is no issuer to check (the step stays skipped); the admin's URL is checked below.
  if (disc.issuer !== null) {
    issuer = disc.issuer;
    pass("issuer");
  }
  tokenEndpoint = endpoint;
  if (!isTrustedEndpoint(endpoint, disc.mcpOrigin)) {
    fail(["endpoints"], "token_endpoint_untrusted");
    return answer();
  }
  pass("endpoints");
  const { clientId, clientSecret } = input.cc ?? {};
  if (!clientId || !clientSecret) {
    // No client or no secret to try (none typed, none usable here): nothing is sent.
    fail(["token"], "token_exchange_failed");
    return answer();
  }
  try {
    // The token is not kept: the grant only proves the credentials and scopes work.
    await clientCredentialsGrant(egress, {
      tokenEndpoint: endpoint,
      issuer: disc.issuer,
      resource: disc.resource,
      sameOrigin: disc.sameOrigin,
      mcpOrigin: disc.mcpOrigin,
      clientId,
      clientSecret,
      scopes: input.scopes,
      authMethods: disc.authMethods,
    });
  } catch (err) {
    fail(["endpoints", "token"], authFailureOf(err));
    return answer();
  }
  pass("token");
  return answer();
}
