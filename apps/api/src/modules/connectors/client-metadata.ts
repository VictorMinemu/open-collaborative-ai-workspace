import type { ConnectorOAuthUrls } from "@ocw/contracts";

/**
 * The instance's OAuth client ID metadata document (CIMD, MCP authorization spec "client registration"): a public
 * client whose `client_id` is the exact https URL the document is served at, with the API's callback as its only
 * redirect URI. Only an https instance can be identified this way; otherwise there is no document (null) and
 * `chooseClient` falls back to a pre-registered client or dynamic registration.
 */
export function clientMetadataDocument(
  urls: ConnectorOAuthUrls,
  clientName: string,
): Record<string, unknown> | null {
  if (!urls.clientMetadataUrl || !urls.redirectUri) return null;
  let url: URL;
  try {
    url = new URL(urls.clientMetadataUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.pathname === "/" || url.hash) return null;
  return {
    client_id: urls.clientMetadataUrl,
    client_name: clientName,
    client_uri: url.origin,
    redirect_uris: [urls.redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}
