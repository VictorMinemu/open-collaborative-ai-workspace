import { OAuthTestRequest, type OAuthTestResponse } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AuthTestResult,
  type AuthTestValues,
  oauthTestRequest,
  publicUrlMismatch,
  testOutcome,
} from "./auth-test-panel";

const ORIGIN = "https://ocw.acme.example";

function values(over: Partial<AuthTestValues> = {}): AuthTestValues {
  return {
    serverId: null,
    url: "https://mcp.acme.example/mcp",
    transport: "streamable-http",
    mode: "org_oauth",
    useCimd: true,
    oauthClient: undefined,
    cc: { clientId: "", clientSecret: "", tokenUrl: "" },
    scopes: [],
    ...over,
  };
}

function response(over: Partial<OAuthTestResponse> = {}): OAuthTestResponse {
  return {
    ok: true,
    failure: null,
    steps: [
      { step: "public_url", status: "ok" },
      { step: "discovery", status: "ok" },
      { step: "issuer", status: "ok" },
      { step: "endpoints", status: "ok" },
      { step: "pkce", status: "ok" },
      { step: "client_registration", status: "ok" },
      { step: "token", status: "skipped" },
    ],
    clientMethod: "pre_registered",
    issuer: "https://auth.acme.example",
    tokenEndpoint: "https://auth.acme.example/token",
    redirectUri: `${ORIGIN}/api/v1/connectors/oauth/callback`,
    clientMetadataUrl: null,
    ...over,
  };
}

describe("oauthTestRequest", () => {
  it("sends the form's sign-in values and the page origin, and passes the contract", () => {
    const req = oauthTestRequest(
      values({
        oauthClient: { issuer: "https://auth.acme.example", clientId: "ocw-docs", clientSecret: "s3cret" },
        scopes: ["docs.read"],
        useCimd: false,
      }),
      ORIGIN,
    );
    expect(req).toEqual({
      url: "https://mcp.acme.example/mcp",
      transport: "streamable-http",
      authMode: "org_oauth",
      oauthUseCimd: false,
      oauthClient: { issuer: "https://auth.acme.example", clientId: "ocw-docs", clientSecret: "s3cret" },
      oauthScopes: ["docs.read"],
      pageOrigin: ORIGIN,
    });
    expect(OAuthTestRequest.safeParse(req).success).toBe(true);
  });

  it("names the saved server, and leaves out an incomplete client (the saved ones are used)", () => {
    const req = oauthTestRequest(
      values({
        serverId: "00000000-0000-4000-8000-000000000001",
        oauthClient: { issuer: "auth", clientId: "" },
      }),
      ORIGIN,
    );
    expect(req.serverId).toBe("00000000-0000-4000-8000-000000000001");
    expect(req).not.toHaveProperty("oauthClient");
    expect(OAuthTestRequest.safeParse(req).success).toBe(true);
  });

  it("client credentials: the secret only when typed (else the stored one is kept), the Token URL only when typed", () => {
    const kept = oauthTestRequest(
      values({
        mode: "org_client_credentials",
        cc: { clientId: " ocw-cc ", clientSecret: "", tokenUrl: "" },
      }),
      ORIGIN,
    );
    expect(kept.clientCredentials).toEqual({ clientId: "ocw-cc" });
    expect(kept).not.toHaveProperty("oauthUseCimd");
    expect(kept).not.toHaveProperty("oauthClient");
    expect(OAuthTestRequest.safeParse(kept).success).toBe(true);
    const typed = oauthTestRequest(
      values({
        mode: "org_client_credentials",
        cc: { clientId: "ocw-cc", clientSecret: "typed", tokenUrl: "https://auth.acme.example/token" },
      }),
      ORIGIN,
    );
    expect(typed.clientCredentials).toEqual({
      clientId: "ocw-cc",
      clientSecret: "typed",
      tokenEndpoint: "https://auth.acme.example/token",
    });
    expect(OAuthTestRequest.safeParse(typed).success).toBe(true);
  });

  it("client credentials without a client id: nothing sent for them (a saved server's are used)", () => {
    const req = oauthTestRequest(
      values({
        serverId: "00000000-0000-4000-8000-000000000001",
        mode: "org_client_credentials",
        cc: { clientId: "", clientSecret: "typed", tokenUrl: "" },
      }),
      ORIGIN,
    );
    expect(req).not.toHaveProperty("clientCredentials");
  });
});

describe("publicUrlMismatch", () => {
  it("is null when the redirect URI and the page share a host (ports may differ)", () => {
    expect(
      publicUrlMismatch("http://127.0.0.1:4290/api/v1/connectors/oauth/callback", "http://127.0.0.1:3290/x"),
    ).toBe(null);
    expect(publicUrlMismatch(`${ORIGIN}/api/v1/connectors/oauth/callback`, `${ORIGIN}/settings`)).toBe(null);
  });

  it("names both hosts when they differ", () => {
    expect(
      publicUrlMismatch(
        "http://localhost:4000/api/v1/connectors/oauth/callback",
        "https://ocw.acme.example/settings",
      ),
    ).toEqual({ redirectHost: "localhost", pageHost: "ocw.acme.example" });
  });

  // 07.14 review WR-05: the server's rule (diagnosis `public_url`). The API on its own HTTPS host beside the web
  // (`docs/self-hosting/reverse-proxy.md` rule 1) is a supported layout, never a wrong public URL.
  it("does not warn for a split-host install with an HTTPS API", () => {
    expect(
      publicUrlMismatch(
        "https://api.acme.example/api/v1/connectors/oauth/callback",
        "https://ocw.acme.example/x",
      ),
    ).toBe(null);
  });

  it("warns for a loopback redirect URI on a page that is not local, and for plain http on another host", () => {
    expect(
      publicUrlMismatch(
        "http://127.0.0.1:4000/api/v1/connectors/oauth/callback",
        "https://ocw.acme.example/x",
      ),
    ).toEqual({ redirectHost: "127.0.0.1", pageHost: "ocw.acme.example" });
    expect(
      publicUrlMismatch("http://ocw-lan:4000/api/v1/connectors/oauth/callback", "https://ocw.acme.example/x"),
    ).toEqual({ redirectHost: "ocw-lan", pageHost: "ocw.acme.example" });
    // Providers refuse plain http on a non-loopback host, wherever the admin opened the page.
    expect(
      publicUrlMismatch("http://ocw-lan:4000/api/v1/connectors/oauth/callback", "http://127.0.0.1:3000/x"),
    ).toEqual({ redirectHost: "ocw-lan", pageHost: "127.0.0.1" });
    // A loopback redirect URI on a local page (the dev stack, the admin on the server itself) is not warned.
    expect(
      publicUrlMismatch("http://localhost:4000/api/v1/connectors/oauth/callback", "http://127.0.0.1:3000/x"),
    ).toBe(null);
  });

  it("is null without a redirect URI or with an unparsable one", () => {
    expect(publicUrlMismatch("", "https://ocw.acme.example/")).toBe(null);
    expect(publicUrlMismatch("not a url", "https://ocw.acme.example/")).toBe(null);
  });
});

describe("testOutcome", () => {
  it("sign-in ready, client credentials issued, or the first failed step with its fix line", () => {
    expect(testOutcome(response(), "org_oauth", "Acme")).toEqual({
      ok: true,
      title: "Acme's sign-in looks ready. Save, then Connect.",
      fix: null,
    });
    expect(testOutcome(response(), "org_client_credentials", "Acme")).toEqual({
      ok: true,
      title: "Acme issued a token. Save to use it.",
      fix: null,
    });
    expect(
      testOutcome(response({ ok: false, failure: "client_registration_unavailable" }), "org_oauth", "Acme"),
    ).toEqual({
      ok: false,
      title: "Sign-in fails at: Client registration",
      fix: "Acme doesn't let OCW register itself. Create an OAuth app at the provider with the redirect URI below, then enter its client ID and secret under Pre-registered client.",
    });
  });
});

describe("AuthTestResult", () => {
  it("lists every step with its status as text, and the fix line, from closed codes only", () => {
    const html = renderToStaticMarkup(
      <AuthTestResult
        result={response({
          ok: false,
          failure: "token_exchange_failed",
          steps: [
            { step: "discovery", status: "ok" },
            { step: "issuer", status: "ok" },
            { step: "endpoints", status: "ok" },
            { step: "token", status: "failed" },
          ],
        })}
        mode="org_client_credentials"
        server="Acme"
      />,
    );
    expect(html.match(/data-testid="mcp-auth-test-step"/g)).toHaveLength(4);
    expect(html).toContain('data-step="token" data-status="failed"');
    expect(html).toContain("Sign-in fails at: Token");
    expect(html).toContain('data-testid="mcp-auth-test-fix"');
    expect(html).toContain(
      "The provider didn&#x27;t finish the sign-in. Check the client ID and secret, then try again.",
    );
    expect(html).toContain("Failed");
    expect(html).toContain("<ol");
  });
});
