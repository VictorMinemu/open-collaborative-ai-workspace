import { readFileSync } from "node:fs";

export const DEFAULT_ACCOUNT_ID = "default";

/**
 * `channels.ocw` section (no secrets here, ever):
 *   { enabled?: boolean, apiUrl?: string, tokenFile?: string, tokenEnv?: string }
 * Env fallbacks: OCW_API_URL, OCW_CELL_TOKEN_FILE, OCW_CELL_TOKEN.
 */
export type OcwChannelSection = {
  enabled?: boolean;
  apiUrl?: string;
  tokenFile?: string;
  tokenEnv?: string;
};

export type ResolvedOcwAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  apiUrl: string | undefined;
  tokenSource: "file" | "env" | "missing";
  /** Reads the cell token on demand (secret files can rotate). Throws when missing. */
  readToken: () => string;
};

type Env = Record<string, string | undefined>;

export function readSection(cfg: { channels?: Record<string, unknown> } | undefined): OcwChannelSection {
  const raw = cfg?.channels?.ocw;
  return raw && typeof raw === "object" ? (raw as OcwChannelSection) : {};
}

export function resolveOcwAccount(
  section: OcwChannelSection,
  env: Env = process.env,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): ResolvedOcwAccount {
  const apiUrl = (section.apiUrl ?? env.OCW_API_URL)?.trim() || undefined;
  const tokenFile = (section.tokenFile ?? env.OCW_CELL_TOKEN_FILE)?.trim() || undefined;
  const tokenEnvName = section.tokenEnv?.trim() || "OCW_CELL_TOKEN";
  const tokenSource: ResolvedOcwAccount["tokenSource"] = tokenFile
    ? "file"
    : env[tokenEnvName]
      ? "env"
      : "missing";
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    enabled: section.enabled !== false,
    configured: Boolean(apiUrl) && tokenSource !== "missing",
    apiUrl,
    tokenSource,
    readToken() {
      const token = tokenFile ? readFile(tokenFile).trim() : (env[tokenEnvName] ?? "").trim();
      if (!token) throw new Error("ocw: cell token is empty (set OCW_CELL_TOKEN_FILE or OCW_CELL_TOKEN)");
      return token;
    },
  };
}
