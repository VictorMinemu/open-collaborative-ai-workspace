"use client";

import {
  authFailureFix,
  type ClientCredentialsInput,
  type ConnectorAuthMode,
  type CreateMcpServerRequest,
  isAllowedInjectionHeader,
  isPerMemberMode,
  type McpHeaderInput,
  McpHeaderName,
  McpMemberHeaderPrefix,
  type McpServer,
  type McpServerList,
  type McpTransport,
  type OrgConnection,
  rendersInCell,
  type UpdateMcpServerRequest,
  usesConnectorProxy,
  usesOAuthSignIn,
} from "@ocw/contracts";
import {
  Check,
  ChevronRight,
  Copy,
  Info,
  Lock,
  Plus,
  Save,
  ShieldCheck,
  TriangleAlert,
  Unplug,
  X,
} from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog as PlainDialog,
  DialogContent as PlainDialogContent,
  DialogDescription as PlainDialogDescription,
  DialogFooter as PlainDialogFooter,
  DialogHeader as PlainDialogHeader,
  DialogTitle as PlainDialogTitle,
} from "@/components/ui/dialog";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/panel-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useCopy } from "@/hooks/use-copy";
import { errorMessage, isApiError } from "@/lib/api";
import {
  CredentialsRefusedError,
  connectionsExistCount,
  useCreateMcpServer,
  useSaveClientCredentials,
  useUpdateMcpServer,
} from "@/lib/mcp-queries";
import { stepLabel, stepOfFailure } from "@/lib/org-connection-format";
import { cn } from "@/lib/utils";

export const TRANSPORTS: Array<{ value: McpTransport; label: string; hint: string }> = [
  { value: "streamable-http", label: "Streamable HTTP", hint: "Most current MCP servers" },
  { value: "sse", label: "SSE (legacy)", hint: "Older servers with an /sse endpoint" },
  { value: "sandboxed-stdio", label: "Sandboxed stdio", hint: "A vetted local server in the sandbox" },
];

interface AuthCard {
  value: ConnectorAuthMode;
  label: string;
  hint: string;
}

/**
 * The Authentication radio cards (07.4-UI-SPEC § 1, 07.14 PD-12), same markup as Transport, in two groups in this
 * fixed order: the organization's own account first, then each member's. Test ids `mcp-auth-group-<key>` and
 * `mcp-auth-mode-<mode>`.
 */
export const AUTH_GROUPS: ReadonlyArray<{
  key: "org" | "member";
  legend: string;
  cards: readonly AuthCard[];
}> = [
  {
    key: "org",
    legend: "For the whole organization",
    cards: [
      { value: "org_secret", label: "Organization headers", hint: "Fixed headers, like an API key" },
      { value: "org_oauth", label: "Organization sign-in", hint: "An admin signs in once for everyone" },
      {
        value: "org_client_credentials",
        label: "Client credentials",
        hint: "A client ID and secret, no browser sign-in",
      },
    ],
  },
  {
    key: "member",
    legend: "Each member's own account",
    cards: [
      {
        value: "per_member_oauth",
        label: "Member sign-in",
        hint: "Each person signs in with their own account",
      },
      { value: "per_member_secret", label: "Member key", hint: "Each person pastes their own key" },
    ],
  },
];

export const AUTH_MODES: readonly AuthCard[] = AUTH_GROUPS.flatMap((g) => g.cards);

function modeExplanation(mode: ConnectorAuthMode, server: string): string {
  switch (mode) {
    case "per_member_oauth":
      return "Each member connects in Settings › Connections. Bots act with the account of whoever asks; results stay in that person's private chats unless they allow a conversation.";
    case "per_member_secret":
      return "Each member adds a key in Settings › Connections. OCW sends it as the header below; bots never see it.";
    case "org_oauth":
      return "An admin signs in once with the organization's account. Every member's bots use it wherever organization tools are allowed. The token stays on the server.";
    case "org_client_credentials":
      return `OCW gets tokens from ${server}'s sign-in server with this client ID and secret. Every member's bots use them wherever organization tools are allowed.`;
    default:
      return `Bots call ${server} with the headers below, whoever asks. Use it for shared tools.`;
  }
}

/** The modes that take Scopes: both sign-in modes and client credentials (the contract's `checkConnectorAuth`). */
const takesScopes = (mode: ConnectorAuthMode) => usesOAuthSignIn(mode) || mode === "org_client_credentials";

/**
 * The client-side twin of the API's `trusted()` for an admin-entered Token URL: https, or http to the MCP server's own
 * origin; never credentials or a fragment in the URL. The API checks it again before any request.
 */
export function trustedTokenUrl(endpoint: string, serverUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol !== "http:") return false;
  try {
    return u.origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
}

/** The stored client credentials of a server (client id, whether a secret is set); null when none are stored. */
function storedCredentials(server: McpServer | null): OrgConnection | null {
  const c = server?.orgConnection ?? null;
  return server?.authMode === "org_client_credentials" && c?.method === "client_credentials" ? c : null;
}

/** No OAuth URLs from an older API: assume nothing (no redirect URI to show, sign-in unavailable). */
const NO_OAUTH: NonNullable<McpServerList["oauth"]> = {
  redirectUri: "",
  clientMetadataUrl: null,
  oauthAvailable: false,
};

/** 44 px touch targets below `md` (UI-SPEC: every control at 390). */
const TOUCH = "max-md:h-11";

interface HeaderRow {
  key: number;
  name: string;
  value: string;
  /** A value is stored for this header (edit mode): it is kept unless the admin replaces it. */
  stored: boolean;
  replace: boolean;
}

type Errors = Partial<
  Record<
    | "name"
    | "url"
    | "sandboxServer"
    | "form"
    | "memberHeader"
    | "memberPrefix"
    | "issuer"
    | "clientId"
    | "scopes"
    | "ccClientId"
    | "ccSecret"
    | "ccTokenUrl"
    /** A second line under `form`: the fix line of a refused client-credentials save. */
    | "formFix",
    string
  >
> & {
  headers?: Record<number, string>;
};

let nextKey = 1;

/**
 * Add or edit an MCP server (D-13). Header values are write-only: a stored value shows as "set" and can be
 * kept or replaced, never read back; typed values leave the DOM when the dialog closes. The API validates
 * the URL policy and headers again and its message is shown inline.
 */
export function McpServerDialog({
  open,
  server,
  sandbox,
  oauth,
  onOpenChange,
}: {
  open: boolean;
  /** Edit this server; null = add a new one. */
  server: McpServer | null;
  sandbox: McpServerList["sandbox"];
  /** The instance's OAuth URLs (redirect URI, client metadata URL, whether member sign-in is possible here). */
  oauth: McpServerList["oauth"];
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="mcp-server-dialog" className="sm:max-w-xl">
        {open ? (
          <ServerForm
            key={server?.id ?? "new"}
            server={server}
            sandbox={sandbox}
            oauth={oauth ?? NO_OAUTH}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ServerForm({
  server,
  sandbox,
  oauth,
  onDone,
}: {
  server: McpServer | null;
  sandbox: McpServerList["sandbox"];
  oauth: NonNullable<McpServerList["oauth"]>;
  onDone: () => void;
}) {
  const create = useCreateMcpServer();
  /**
   * The server as last saved by this dialog: a Save whose credentials were refused has already created or updated the
   * server, so the next Save edits that state (it never adds the server twice).
   */
  const [saved, setSaved] = useState<McpServer | null>(null);
  const base = saved ?? server;
  const update = useUpdateMcpServer(base?.id ?? "");
  const saveCredentials = useSaveClientCredentials();
  const editing = base !== null;
  const [name, setName] = useState(server?.name ?? "");
  const [transport, setTransport] = useState<McpTransport>(server?.transport ?? "streamable-http");
  const [url, setUrl] = useState(server?.url ?? "");
  const [sandboxServer, setSandboxServer] = useState(server?.sandboxServer ?? sandbox.servers[0] ?? "");
  const [headers, setHeaders] = useState<HeaderRow[]>(
    (server?.headers ?? []).map((h) => ({
      key: nextKey++,
      name: h.name,
      value: "",
      stored: true,
      replace: false,
    })),
  );
  const [authMode, setAuthMode] = useState<ConnectorAuthMode>(server?.authMode ?? "org_secret");
  const [memberHeader, setMemberHeader] = useState(server?.memberHeaderName ?? "Authorization");
  const [memberPrefix, setMemberPrefix] = useState(server?.memberHeaderPrefix ?? "");
  const storedClient = server?.oauthClients.find((c) => c.method === "pre_registered") ?? null;
  /** `stored` = keep the saved client, `edit` = typing a new one, `removed` = delete it on save. */
  const [clientState, setClientState] = useState<"stored" | "edit" | "removed">(
    storedClient ? "stored" : "edit",
  );
  const [clientOpen, setClientOpen] = useState(
    storedClient !== null || (server?.oauthScopes?.length ?? 0) > 0,
  );
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [scopes, setScopes] = useState((server?.oauthScopes ?? []).join(" "));
  // WINDOWS #179: identify OCW with its client metadata URL (default), or not when the provider cannot reach it.
  const [useCimd, setUseCimd] = useState(server?.oauthUseCimd ?? true);
  // Client credentials (07.14 D-03): the client id is an identifier and is shown; the secret is write-only, never
  // prefilled (a stored one reads "Secret set" + Replace) and cleared after a save and when the dialog closes.
  const [ccClientId, setCcClientId] = useState(storedCredentials(server)?.clientId ?? "");
  const [ccSecret, setCcSecret] = useState("");
  const [ccReplace, setCcReplace] = useState(false);
  const [ccTokenUrl, setCcTokenUrl] = useState("");
  const savedCc = storedCredentials(base);
  /** A stored secret is kept only for the same client: another client id needs its own secret (the API's rule). */
  const keepsStoredSecret =
    savedCc?.hasSecret === true && !ccReplace && ccClientId.trim() === savedCc.clientId;
  const [errors, setErrors] = useState<Errors>({});
  /** The mode-switch confirmation: how many members it disconnects and the PATCH it will send. */
  const [confirm, setConfirm] = useState<{ count: number; body: UpdateMcpServerRequest } | null>(null);
  const pending = create.isPending || update.isPending || saveCredentials.isPending;
  const sandboxed = transport === "sandboxed-stdio";
  const serverLabel = name.trim() || "this server";

  /** Why a card can't be picked (it replaces the card's hint), or null. */
  function disabledReason(mode: ConnectorAuthMode): string | null {
    // Accounts (the organization's or a member's) go through the API proxy: never the stdio sandbox.
    if (sandboxed && usesConnectorProxy(mode)) return "Needs a remote server";
    // Sign-in stays selectable for a server already in that mode, so an admin can still edit it.
    if (usesOAuthSignIn(mode) && !oauth.oauthAvailable && base?.authMode !== mode) return "Needs HTTPS";
    return null;
  }

  const clearError = (...keys: Array<keyof Errors>) =>
    setErrors((e) => {
      const next = { ...e, form: undefined };
      for (const k of keys) delete next[k];
      return next;
    });

  function pickTransport(t: McpTransport) {
    setTransport(t);
    // Member accounts need a remote server: the stdio sandbox falls back to the organization secret.
    if (t === "sandboxed-stdio") setAuthMode("org_secret");
  }

  function scopeList(): string[] {
    return scopes.split(/\s+/).filter(Boolean);
  }

  /** The typed client, or undefined when the admin left all its fields empty. */
  function typedClient(): { issuer: string; clientId: string; clientSecret?: string } | undefined {
    if (!issuer.trim() && !clientId.trim() && !clientSecret) return undefined;
    return {
      issuer: issuer.trim(),
      clientId: clientId.trim(),
      ...(clientSecret ? { clientSecret } : {}),
    };
  }

  const patchHeader = (key: number, patch: Partial<HeaderRow>) => {
    setHeaders((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setErrors((e) => ({ ...e, headers: undefined, form: undefined }));
  };

  function validate(): Errors {
    const next: Errors = {};
    if (!name.trim()) next.name = "Give the server a name";
    if (!sandboxed && !url.trim()) next.url = "Enter the server's URL";
    if (sandboxed && !sandboxServer) next.sandboxServer = "Pick a vetted server";
    if (authMode === "per_member_secret") {
      const h = memberHeader.trim();
      if (!h) next.memberHeader = "Enter a header name";
      else if (!McpHeaderName.safeParse(h).success) next.memberHeader = "Letters, digits and dashes only";
      else if (!isAllowedInjectionHeader(h)) next.memberHeader = `${h} can't carry a member's key`;
      if (!McpMemberHeaderPrefix.safeParse(memberPrefix).success) {
        next.memberPrefix = "The prefix can't contain line breaks";
      }
    }
    if (authMode === "per_member_oauth" && clientState === "edit") {
      const c = typedClient();
      if (c) {
        if (!/^https?:\/\/\S+$/.test(c.issuer)) next.issuer = "Enter the issuer's URL";
        if (!c.clientId) next.clientId = "Enter the client ID";
      }
    }
    if (takesScopes(authMode) && scopeList().some((s) => s.length > 200)) {
      next.scopes = "Each scope is at most 200 characters";
    }
    if (authMode === "org_client_credentials") {
      if (!ccClientId.trim()) next.ccClientId = "Enter the client ID";
      if (!keepsStoredSecret && !ccSecret) next.ccSecret = "Enter the client secret";
      const tokenUrl = ccTokenUrl.trim();
      if (tokenUrl && !trustedTokenUrl(tokenUrl, url.trim())) {
        next.ccTokenUrl = "Use an https address (or this server's own address)";
      }
    }
    if (!rendersInCell(authMode)) return next;
    const headerErrors: Record<number, string> = {};
    const seen = new Set<string>();
    for (const h of headers) {
      const n = h.name.trim();
      if (!McpHeaderName.safeParse(n).success) headerErrors[h.key] = "Letters, digits and dashes only";
      else if (seen.has(n.toLowerCase())) headerErrors[h.key] = "This header is listed twice";
      else if ((!h.stored || h.replace) && !h.value) headerErrors[h.key] = "Enter a value";
      seen.add(n.toLowerCase());
    }
    if (Object.keys(headerErrors).length > 0) next.headers = headerErrors;
    return next;
  }

  function headerInputs(): McpHeaderInput[] {
    return headers.map((h) =>
      h.stored && !h.replace ? { name: h.name.trim(), keep: true } : { name: h.name.trim(), value: h.value },
    );
  }

  /** The chosen mode's connector fields for a new server (only that mode's: hidden blocks are discarded). */
  function createConnectorFields(): Pick<
    CreateMcpServerRequest,
    "memberHeaderName" | "memberHeaderPrefix" | "oauthScopes" | "oauthClient" | "oauthUseCimd"
  > {
    if (authMode === "per_member_secret") {
      return {
        memberHeaderName: memberHeader.trim(),
        ...(memberPrefix ? { memberHeaderPrefix: memberPrefix } : {}),
      };
    }
    if (authMode === "per_member_oauth") {
      const list = scopeList();
      const client = typedClient();
      return {
        ...(list.length > 0 ? { oauthScopes: list } : {}),
        ...(client ? { oauthClient: client } : {}),
        ...(useCimd ? {} : { oauthUseCimd: false }),
      };
    }
    if (authMode === "org_client_credentials") {
      const list = scopeList();
      return list.length > 0 ? { oauthScopes: list } : {};
    }
    return {};
  }

  /** What changed in the chosen mode's connector fields (all of them on a mode switch); null clears. */
  function updateConnectorFields(
    saved: McpServer,
    modeChanged: boolean,
  ): Pick<
    UpdateMcpServerRequest,
    "memberHeaderName" | "memberHeaderPrefix" | "oauthScopes" | "oauthClient" | "oauthUseCimd"
  > {
    const out: Pick<
      UpdateMcpServerRequest,
      "memberHeaderName" | "memberHeaderPrefix" | "oauthScopes" | "oauthClient" | "oauthUseCimd"
    > = {};
    if (authMode === "per_member_secret") {
      const h = memberHeader.trim();
      if (modeChanged || h !== saved.memberHeaderName) out.memberHeaderName = h;
      if (modeChanged ? memberPrefix !== "" : memberPrefix !== (saved.memberHeaderPrefix ?? "")) {
        out.memberHeaderPrefix = memberPrefix || null;
      }
    }
    if (authMode === "per_member_oauth") {
      const list = scopeList();
      const before = modeChanged ? [] : (saved.oauthScopes ?? []);
      if (list.join(" ") !== before.join(" ")) out.oauthScopes = list.length === 0 ? null : list;
      if (clientState === "edit") {
        const c = typedClient();
        if (c) out.oauthClient = c;
      } else if (clientState === "removed" && !modeChanged) {
        out.oauthClient = null;
      }
      if (useCimd !== (modeChanged ? true : (saved.oauthUseCimd ?? true))) out.oauthUseCimd = useCimd;
    }
    if (authMode === "org_client_credentials") {
      // The server keeps the scopes across the modes that take them; the DTO has none for the others.
      const list = scopeList();
      if (list.join(" ") !== (saved.oauthScopes ?? []).join(" "))
        out.oauthScopes = list.length === 0 ? null : list;
    }
    return out;
  }

  /** The credentials to send: a new server or client, a typed secret or Token URL; null = nothing changed. */
  function credentialsToSave(target: McpServer): ClientCredentialsInput | null {
    if (authMode !== "org_client_credentials") return null;
    const stored = storedCredentials(target);
    const clientId = ccClientId.trim();
    const tokenEndpoint = ccTokenUrl.trim();
    if (stored && clientId === stored.clientId && !ccSecret && !tokenEndpoint) return null;
    return {
      clientId,
      ...(ccSecret ? { clientSecret: ccSecret } : {}),
      ...(tokenEndpoint ? { tokenEndpoint } : {}),
    };
  }

  /**
   * Saves the client credentials after the server (create or update) when they changed. A refused grant keeps the
   * dialog open with the step and its fix line (closed codes only, never the provider's text); false = stop there.
   */
  async function persistCredentials(target: McpServer): Promise<boolean> {
    const body = credentialsToSave(target);
    if (!body) return true;
    try {
      await saveCredentials.mutateAsync({ serverId: target.id, body });
      setCcSecret("");
      return true;
    } catch (err) {
      if (err instanceof CredentialsRefusedError) {
        setErrors({
          form: `Client credentials failed at: ${stepLabel(stepOfFailure(err.failure))}.`,
          formFix: authFailureFix(err.failure, target.name),
        });
      } else if (isApiError(err) && err.code === "secret_required") {
        setCcReplace(true);
        setErrors({ ccSecret: errorMessage(err) });
      } else {
        showError(err);
      }
      return false;
    }
  }

  function showError(err: unknown) {
    const code = isApiError(err) ? err.code : "";
    const message = errorMessage(err);
    if (code === "invalid_url" || code === "url_required" || code === "url_not_allowed") {
      setErrors({ url: message });
    } else if (code === "unknown_sandbox_server" || code === "sandbox_unavailable") {
      setErrors({ sandboxServer: message });
    } else if (code === "member_header_forbidden" || code === "member_header_required") {
      setErrors({ memberHeader: message });
    } else if (code === "invalid_scope") {
      setErrors({ scopes: message });
    } else {
      setErrors({ form: message });
    }
  }

  function finish() {
    setHeaders([]);
    setClientSecret("");
    setCcSecret("");
    onDone();
  }

  /** The PATCH (when anything changed), then the client credentials; throws the PATCH's error for the caller. */
  async function saveUpdate(target: McpServer, body: UpdateMcpServerRequest) {
    let current = target;
    if (Object.keys(body).length > 0) {
      current = await update.mutateAsync(body);
      setSaved(current);
    }
    if (!(await persistCredentials(current))) return;
    toast.success(`${name.trim()} saved`, {
      description:
        rendersInCell(authMode) && (body.url || body.headers || body.sandboxServer || body.authMode)
          ? "Its tools are being checked again."
          : undefined,
    });
    finish();
  }

  function addedDescription(mode: ConnectorAuthMode): string {
    if (rendersInCell(mode)) return "Your bots' runtime is discovering its tools.";
    if (mode === "org_oauth") return "Connect the organization's account from its row to use its tools.";
    if (mode === "org_client_credentials") return "Its client credentials work. Bots can use its tools.";
    return "Its tools appear after the first member connects.";
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next = validate();
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    if (base) {
      const body: UpdateMcpServerRequest = {};
      if (name.trim() !== base.name) body.name = name.trim();
      if (!sandboxed && url.trim() !== (base.url ?? "")) body.url = url.trim();
      if (sandboxed && sandboxServer !== base.sandboxServer) body.sandboxServer = sandboxServer;
      const modeChanged = authMode !== base.authMode;
      if (modeChanged) body.authMode = authMode;
      if (rendersInCell(authMode)) {
        const headersChanged =
          headers.length !== base.headers.length ||
          headers.some((h) => !h.stored || h.replace) ||
          headers.some((h, i) => h.name.trim() !== base.headers[i]?.name);
        if (headersChanged) body.headers = headerInputs();
      }
      Object.assign(body, updateConnectorFields(base, modeChanged));
      // Leaving a member mode deletes every member's sign-in or key: ask first, with the count the list already has
      // (R4). Nothing is sent until the admin confirms.
      if (modeChanged && isPerMemberMode(base.authMode) && base.memberConnections > 0) {
        setConfirm({ count: base.memberConnections, body });
        return;
      }
      try {
        await saveUpdate(base, body);
      } catch (err) {
        // Fallback: members connected since the list loaded. The same confirmation opens with the server's count.
        const count = connectionsExistCount(err);
        if (count !== null) setConfirm({ count, body });
        else showError(err);
      }
      return;
    }
    const body: CreateMcpServerRequest = {
      name: name.trim(),
      transport,
      ...(sandboxed ? { sandboxServer } : { url: url.trim() }),
      // Values typed in a hidden block are discarded: only the chosen mode's fields are sent.
      headers: rendersInCell(authMode) ? headerInputs() : [],
      orgEnabled: true,
      personalAllowed: false,
      trustedChaining: false,
      authMode,
      ...createConnectorFields(),
    };
    let created: McpServer;
    try {
      created = await create.mutateAsync(body);
    } catch (err) {
      showError(err);
      return;
    }
    setSaved(created);
    // The server exists from here on; refused credentials keep the dialog open on it (the next Save edits it).
    if (!(await persistCredentials(created))) return;
    toast.success(`${body.name} added`, { description: addedDescription(authMode) });
    finish();
  }

  async function confirmSwitch() {
    if (!confirm || !base) return;
    try {
      await saveUpdate(base, { ...confirm.body, clearConnections: true });
      setConfirm(null);
    } catch (err) {
      setConfirm(null);
      showError(err);
    }
  }

  /** Scopes: one field shared by both sign-in modes and client credentials (only one block renders at a time). */
  const scopesField = (
    <FormField
      id="mcp-oauth-scopes"
      label="Scopes"
      hint="Optional. Separate with spaces."
      error={errors.scopes}
    >
      <Input
        id="mcp-oauth-scopes"
        value={scopes}
        placeholder="crm.read crm.write"
        onChange={(e) => {
          setScopes(e.target.value);
          clearError("scopes");
        }}
        aria-invalid={!!errors.scopes}
        aria-describedby={describedBy("mcp-oauth-scopes", errors.scopes, "x")}
        autoComplete="off"
        spellCheck={false}
        className={cn("font-mono text-[13px]", TOUCH)}
        data-testid="mcp-oauth-scopes"
      />
    </FormField>
  );

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>{base ? `Edit ${base.name}` : "Add an MCP server"}</DialogTitle>
        <DialogDescription>
          Its tools become available to bots. Each tool stays off until someone who manages a bot turns it on.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="grid gap-5">
        <FormField id="mcp-name" label="Name" error={errors.name}>
          <Input
            id="mcp-name"
            value={name}
            maxLength={80}
            placeholder="Docs"
            onChange={(e) => {
              setName(e.target.value);
              setErrors((x) => ({ ...x, name: undefined }));
            }}
            aria-invalid={!!errors.name}
            aria-describedby={describedBy("mcp-name", errors.name)}
            className={TOUCH}
            data-testid="mcp-name"
          />
        </FormField>

        <fieldset className="grid gap-2">
          <legend className="mb-2 font-medium text-sm">Transport</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {TRANSPORTS.map((t) => {
              const unavailable = t.value === "sandboxed-stdio" && !sandbox.available;
              const selected = transport === t.value;
              return (
                <label
                  key={t.value}
                  className={cn(
                    "flex cursor-pointer items-start gap-2.5 rounded-lg border bg-card p-2.5 transition-colors max-md:min-h-11 sm:flex-col sm:gap-1",
                    selected && "border-primary/50 bg-brand-soft/40 ring-1 ring-primary/30",
                    (unavailable || (editing && !selected)) && "cursor-not-allowed opacity-60",
                  )}
                  data-testid={`mcp-transport-${t.value}`}
                >
                  <input
                    type="radio"
                    name="mcp-transport"
                    value={t.value}
                    checked={selected}
                    disabled={unavailable || (editing && !selected)}
                    onChange={() => pickTransport(t.value)}
                    className="mt-0.5 size-4 shrink-0 accent-primary sm:sr-only"
                  />
                  <span className="min-w-0">
                    <span className="block font-medium text-[13px]">{t.label}</span>
                    <span className="block text-[11.5px] text-muted-foreground leading-snug">
                      {unavailable ? "Sandbox not configured" : t.hint}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {sandboxed ? (
          <FormField id="mcp-sandbox" label="Vetted server" error={errors.sandboxServer}>
            <Select
              items={sandbox.servers.map((s) => ({ value: s, label: s }))}
              value={sandboxServer}
              onValueChange={(v) => v && setSandboxServer(String(v))}
            >
              <SelectTrigger id="mcp-sandbox" aria-label="Vetted server" className="font-mono text-[13px]" />
              <SelectContent>
                {sandbox.servers.map((s) => (
                  <SelectItem key={s} value={s} className="font-mono text-[13px]">
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        ) : (
          <FormField
            id="mcp-url"
            label="URL"
            error={errors.url}
            hint="HTTPS, or http to an internal service name"
          >
            <Input
              id="mcp-url"
              type="url"
              inputMode="url"
              value={url}
              placeholder="https://mcp.example.com/mcp"
              onChange={(e) => {
                setUrl(e.target.value);
                setErrors((x) => ({ ...x, url: undefined, form: undefined }));
              }}
              aria-invalid={!!errors.url}
              aria-describedby={describedBy("mcp-url", errors.url, "x")}
              autoComplete="off"
              spellCheck={false}
              className={cn("font-mono text-[13px]", TOUCH)}
              data-testid="mcp-url"
            />
          </FormField>
        )}

        <fieldset className="grid gap-3" data-testid="mcp-auth-modes">
          <legend className="mb-2 font-medium text-sm">Authentication</legend>
          {AUTH_GROUPS.map((g) => (
            <fieldset key={g.key} className="grid min-w-0 gap-1.5" data-testid={`mcp-auth-group-${g.key}`}>
              <legend className="mb-1.5 font-semibold text-muted-foreground text-xs">{g.legend}</legend>
              <div className={cn("grid gap-2", g.cards.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
                {g.cards.map((m) => {
                  const reason = disabledReason(m.value);
                  const disabled = reason !== null;
                  const selected = authMode === m.value;
                  return (
                    <label
                      key={m.value}
                      className={cn(
                        "flex cursor-pointer items-start gap-2.5 rounded-lg border bg-card p-2.5 transition-colors max-md:min-h-11 sm:flex-col sm:gap-1",
                        selected && "border-primary/50 bg-brand-soft/40 ring-1 ring-primary/30",
                        disabled && "cursor-not-allowed opacity-60",
                      )}
                      data-testid={`mcp-auth-mode-${m.value}`}
                    >
                      <input
                        type="radio"
                        name="mcp-auth-mode"
                        value={m.value}
                        checked={selected}
                        disabled={disabled}
                        onChange={() => {
                          setAuthMode(m.value);
                          clearError(
                            "memberHeader",
                            "memberPrefix",
                            "issuer",
                            "clientId",
                            "scopes",
                            "ccClientId",
                            "ccSecret",
                            "ccTokenUrl",
                            "formFix",
                          );
                        }}
                        className="mt-0.5 size-4 shrink-0 accent-primary sm:sr-only"
                      />
                      <span className="min-w-0">
                        <span className="block font-medium text-[13px]">{m.label}</span>
                        {/* A disabled option's reason replaces its hint, so it is read with the option. */}
                        <span className="block text-[11.5px] text-muted-foreground leading-snug">
                          {reason ?? m.hint}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
          {!oauth.oauthAvailable ? (
            <p
              role="note"
              className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-[13px] leading-snug"
              data-testid="mcp-oauth-https-hint"
            >
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
              <span>
                Member sign-in needs HTTPS. Run{" "}
                <code className="font-mono text-[12px]">pnpm ocw enable proxy</code> on the server, then
                reload this page.
              </span>
            </p>
          ) : null}
          <p
            className="flex items-start gap-2 rounded-lg bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground leading-snug"
            data-testid="mcp-auth-explanation"
          >
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{modeExplanation(authMode, serverLabel)}</span>
          </p>
        </fieldset>

        {authMode === "per_member_oauth" ? (
          <div className="grid gap-4" data-testid="mcp-oauth-fields">
            {oauth.redirectUri ? (
              <CopyField
                id="mcp-redirect-uri"
                label="Redirect URI"
                value={oauth.redirectUri}
                hint="Register this at the provider if it asks for one."
                copyLabel="Copy redirect URI"
              />
            ) : null}
            {oauth.clientMetadataUrl ? (
              <CopyField
                id="mcp-client-metadata-url"
                label="Client metadata URL"
                value={oauth.clientMetadataUrl}
                hint="Providers that accept client metadata documents need nothing else."
                copyLabel="Copy client metadata URL"
              />
            ) : null}
            {oauth.clientMetadataUrl ? (
              // biome-ignore lint/a11y/noLabelWithoutControl: the Switch renders the control inside the label
              <label
                className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border bg-background px-3 py-2 max-md:min-h-11"
                data-testid="mcp-oauth-cimd"
              >
                <span className="min-w-0">
                  <span className="block font-medium text-[13px]">Use the client metadata URL</span>
                  <span id="mcp-oauth-cimd-hint" className="block text-muted-foreground text-xs leading-snug">
                    Turn this off if {serverLabel}'s sign-in can't reach this workspace, for example behind a
                    private certificate. OCW then uses the pre-registered client or registers itself.
                  </span>
                </span>
                <Switch
                  checked={useCimd}
                  onCheckedChange={setUseCimd}
                  aria-label="Use the client metadata URL"
                  aria-describedby="mcp-oauth-cimd-hint"
                  data-testid="mcp-oauth-cimd-switch"
                />
              </label>
            ) : null}
            <div className="grid gap-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={clientOpen}
                aria-controls="mcp-oauth-client"
                onClick={() => setClientOpen((o) => !o)}
                className={cn("w-fit -ml-2", TOUCH)}
                data-testid="mcp-oauth-client-toggle"
              >
                <ChevronRight className={cn("transition-transform", clientOpen && "rotate-90")} aria-hidden />
                Pre-registered client (optional)
              </Button>
              {clientOpen ? (
                <div id="mcp-oauth-client" className="grid gap-4 border-l-2 pl-3">
                  {clientState === "stored" && storedClient ? (
                    <div
                      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-dashed px-3 py-2 text-xs"
                      data-testid="mcp-oauth-client-stored"
                    >
                      <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1 break-all text-muted-foreground">
                        Issuer <span className="font-mono text-foreground">{storedClient.issuer}</span> ·
                        Client ID <span className="font-mono text-foreground">{storedClient.clientId}</span> ·{" "}
                        {storedClient.hasSecret ? "Secret set" : "No secret"}
                      </span>
                      <span className="flex gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className={TOUCH}
                          onClick={() => {
                            setIssuer(storedClient.issuer);
                            setClientId(storedClient.clientId);
                            setClientState("edit");
                          }}
                        >
                          Replace
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className={TOUCH}
                          onClick={() => setClientState("removed")}
                          data-testid="mcp-oauth-client-remove"
                        >
                          Remove
                        </Button>
                      </span>
                    </div>
                  ) : clientState === "removed" ? (
                    <p className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-muted-foreground text-xs">
                      <span className="flex-1">The pre-registered client is removed when you save.</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={TOUCH}
                        onClick={() => setClientState(storedClient ? "stored" : "edit")}
                      >
                        Keep it
                      </Button>
                    </p>
                  ) : (
                    <>
                      <FormField id="mcp-oauth-issuer" label="Issuer URL" error={errors.issuer}>
                        <Input
                          id="mcp-oauth-issuer"
                          type="url"
                          inputMode="url"
                          value={issuer}
                          placeholder="https://auth.example.com"
                          onChange={(e) => {
                            setIssuer(e.target.value);
                            clearError("issuer");
                          }}
                          aria-invalid={!!errors.issuer}
                          aria-describedby={describedBy("mcp-oauth-issuer", errors.issuer)}
                          autoComplete="off"
                          spellCheck={false}
                          className={cn("font-mono text-[13px]", TOUCH)}
                          data-testid="mcp-oauth-issuer"
                        />
                      </FormField>
                      <FormField id="mcp-oauth-client-id" label="Client ID" error={errors.clientId}>
                        <Input
                          id="mcp-oauth-client-id"
                          value={clientId}
                          maxLength={256}
                          placeholder="ocw-production"
                          onChange={(e) => {
                            setClientId(e.target.value);
                            clearError("clientId");
                          }}
                          aria-invalid={!!errors.clientId}
                          aria-describedby={describedBy("mcp-oauth-client-id", errors.clientId)}
                          autoComplete="off"
                          spellCheck={false}
                          className={cn("font-mono text-[13px]", TOUCH)}
                          data-testid="mcp-oauth-client-id"
                        />
                      </FormField>
                      <FormField
                        id="mcp-oauth-client-secret"
                        label="Client secret"
                        hint="Optional. Write-only."
                      >
                        <Input
                          id="mcp-oauth-client-secret"
                          type="password"
                          value={clientSecret}
                          maxLength={4096}
                          onChange={(e) => setClientSecret(e.target.value)}
                          aria-describedby="mcp-oauth-client-secret-hint"
                          autoComplete="new-password"
                          spellCheck={false}
                          className={cn("font-mono text-[13px]", TOUCH)}
                          data-testid="mcp-oauth-client-secret"
                        />
                      </FormField>
                    </>
                  )}
                  {scopesField}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {authMode === "org_client_credentials" ? (
          <div className="grid gap-4" data-testid="mcp-cc-fields">
            <FormField id="mcp-cc-client-id" label="Client ID" error={errors.ccClientId}>
              <Input
                id="mcp-cc-client-id"
                value={ccClientId}
                maxLength={256}
                placeholder="ocw-production"
                onChange={(e) => {
                  setCcClientId(e.target.value);
                  clearError("ccClientId", "ccSecret", "formFix");
                }}
                aria-invalid={!!errors.ccClientId}
                aria-describedby={describedBy("mcp-cc-client-id", errors.ccClientId)}
                autoComplete="off"
                spellCheck={false}
                className={cn("font-mono text-[13px]", TOUCH)}
                data-testid="mcp-cc-client-id"
              />
            </FormField>
            {keepsStoredSecret ? (
              <div className="grid gap-2">
                <span className="font-medium text-sm">Client secret</span>
                <div
                  className="flex min-w-0 items-center gap-2 rounded-lg border border-dashed px-3 py-1.5 text-xs max-md:min-h-11"
                  data-testid="mcp-cc-secret-stored"
                >
                  <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">Secret set</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={TOUCH}
                    onClick={() => setCcReplace(true)}
                    data-testid="mcp-cc-secret-replace"
                  >
                    Replace
                  </Button>
                </div>
              </div>
            ) : (
              <FormField
                id="mcp-cc-client-secret"
                label="Client secret"
                hint="Write-only. Never shown again."
                error={errors.ccSecret}
                action={
                  ccReplace && savedCc?.hasSecret ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={cn("-my-1", TOUCH)}
                      onClick={() => {
                        setCcReplace(false);
                        setCcSecret("");
                        clearError("ccSecret");
                      }}
                      data-testid="mcp-cc-secret-keep"
                    >
                      Keep the saved secret
                    </Button>
                  ) : null
                }
              >
                <Input
                  id="mcp-cc-client-secret"
                  type="password"
                  value={ccSecret}
                  maxLength={4096}
                  onChange={(e) => {
                    setCcSecret(e.target.value);
                    clearError("ccSecret", "formFix");
                  }}
                  aria-invalid={!!errors.ccSecret}
                  aria-describedby={describedBy("mcp-cc-client-secret", errors.ccSecret, "x")}
                  autoComplete="new-password"
                  spellCheck={false}
                  className={cn("font-mono text-[13px]", TOUCH)}
                  data-testid="mcp-cc-client-secret"
                />
              </FormField>
            )}
            <FormField
              id="mcp-cc-token-url"
              label="Token URL (optional)"
              hint="Leave empty to use the server's published sign-in information."
              error={errors.ccTokenUrl}
            >
              <Input
                id="mcp-cc-token-url"
                type="url"
                inputMode="url"
                value={ccTokenUrl}
                maxLength={2000}
                placeholder="https://auth.example.com/oauth/token"
                onChange={(e) => {
                  setCcTokenUrl(e.target.value);
                  clearError("ccTokenUrl", "formFix");
                }}
                aria-invalid={!!errors.ccTokenUrl}
                aria-describedby={describedBy("mcp-cc-token-url", errors.ccTokenUrl, "x")}
                autoComplete="off"
                spellCheck={false}
                className={cn("font-mono text-[13px]", TOUCH)}
                data-testid="mcp-cc-token-url"
              />
            </FormField>
            {scopesField}
          </div>
        ) : null}

        {authMode === "per_member_secret" ? (
          <div className="grid gap-4 sm:grid-cols-2" data-testid="mcp-member-key-fields">
            <FormField id="mcp-member-header" label="Header name" error={errors.memberHeader}>
              <Input
                id="mcp-member-header"
                value={memberHeader}
                maxLength={64}
                onChange={(e) => {
                  setMemberHeader(e.target.value);
                  clearError("memberHeader");
                }}
                aria-invalid={!!errors.memberHeader}
                aria-describedby={describedBy("mcp-member-header", errors.memberHeader)}
                autoComplete="off"
                spellCheck={false}
                className={cn("font-mono text-[13px]", TOUCH)}
                data-testid="mcp-member-header"
              />
            </FormField>
            <FormField id="mcp-member-prefix" label="Prefix" error={errors.memberPrefix}>
              <Input
                id="mcp-member-prefix"
                value={memberPrefix}
                maxLength={32}
                placeholder="Bearer "
                onChange={(e) => {
                  setMemberPrefix(e.target.value);
                  clearError("memberPrefix");
                }}
                aria-invalid={!!errors.memberPrefix}
                aria-describedby={errors.memberPrefix ? "mcp-member-prefix-error" : "mcp-member-key-hint"}
                autoComplete="off"
                spellCheck={false}
                className={cn("font-mono text-[13px]", TOUCH)}
                data-testid="mcp-member-prefix"
              />
            </FormField>
            <p id="mcp-member-key-hint" className="text-[13px] text-muted-foreground sm:col-span-2">
              Members paste only the key. The prefix is added for them.
            </p>
          </div>
        ) : null}

        {rendersInCell(authMode) ? (
          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-sm">Headers</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={headers.length >= 8}
                className={TOUCH}
                onClick={() =>
                  setHeaders((rows) => [
                    ...rows,
                    {
                      key: nextKey++,
                      name: rows.length === 0 ? "Authorization" : "",
                      value: "",
                      stored: false,
                      replace: false,
                    },
                  ])
                }
                data-testid="mcp-add-header"
              >
                <Plus /> Add header
              </Button>
            </div>
            {headers.length === 0 ? (
              <p className="rounded-lg border border-dashed px-3 py-3 text-muted-foreground text-xs">
                No headers. Add one for an API key or a bearer token.
              </p>
            ) : (
              <ul className="grid gap-2">
                {headers.map((h, i) => {
                  const error = errors.headers?.[h.key];
                  const showValue = !h.stored || h.replace;
                  return (
                    <li key={h.key} className="grid gap-1" data-testid="mcp-header-row">
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
                        <Input
                          value={h.name}
                          onChange={(e) => patchHeader(h.key, { name: e.target.value })}
                          readOnly={h.stored}
                          placeholder="Header"
                          aria-label={`Header ${i + 1} name`}
                          aria-invalid={!!error}
                          spellCheck={false}
                          className={cn("font-mono text-[13px]", TOUCH, h.stored && "bg-muted/40")}
                          data-testid="mcp-header-name"
                        />
                        <div className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto">
                          {showValue ? (
                            <Input
                              type="password"
                              value={h.value}
                              onChange={(e) => patchHeader(h.key, { value: e.target.value })}
                              placeholder={h.stored ? "New value" : "Value"}
                              autoComplete="new-password"
                              spellCheck={false}
                              aria-label={`${h.name || `Header ${i + 1}`} value`}
                              aria-invalid={!!error}
                              className={cn("font-mono text-[13px]", TOUCH)}
                              data-testid="mcp-header-value"
                            />
                          ) : (
                            <span className="flex h-9 items-center gap-2 rounded-md border border-dashed px-3 text-muted-foreground text-xs max-md:h-11">
                              <Lock className="size-3.5 shrink-0" aria-hidden />
                              <span className="truncate">Value set, hidden</span>
                            </span>
                          )}
                        </div>
                        <div className="col-start-2 row-start-1 flex items-center gap-1 sm:col-start-auto sm:row-start-auto">
                          {h.stored ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className={TOUCH}
                              onClick={() => patchHeader(h.key, { replace: !h.replace, value: "" })}
                            >
                              {h.replace ? "Keep" : "Replace"}
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="max-md:size-11"
                            aria-label={`Remove header ${h.name || i + 1}`}
                            onClick={() => setHeaders((rows) => rows.filter((r) => r.key !== h.key))}
                          >
                            <X />
                          </Button>
                        </div>
                      </div>
                      {error ? (
                        <p role="alert" className="text-[13px] text-destructive">
                          {error}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
              <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
              Values are encrypted and only sent to your bots' runtime. They are never shown again.
            </p>
          </div>
        ) : null}

        {errors.form ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-[13px] text-destructive"
            data-testid="mcp-form-error"
          >
            <span className="block font-medium">{errors.form}</span>
            {errors.formFix ? <span className="mt-0.5 block">{errors.formFix}</span> : null}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={pending} className={TOUCH}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending} className={TOUCH} data-testid="mcp-save">
          {pending ? <Spinner /> : editing ? <Save /> : <Plus />}
          {editing ? "Save" : "Add server"}
        </Button>
      </DialogFooter>
      {base ? (
        <ClearConnectionsDialog
          open={confirm !== null}
          count={confirm?.count ?? 0}
          serverName={base.name}
          toMode={authMode}
          pending={update.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void confirmSwitch()}
        />
      ) : null}
    </form>
  );
}

/** A read-only URL the admin copies to the provider; it scrolls inside its input and never widens the dialog. */
function CopyField({
  id,
  label,
  value,
  hint,
  copyLabel,
}: {
  id: string;
  label: string;
  value: string;
  hint: string;
  copyLabel: string;
}) {
  const { copy, copied } = useCopy(2000);
  const done = copied === value;
  return (
    <FormField id={id} label={label} hint={hint}>
      <div className="flex min-w-0 items-center gap-2">
        <Input
          id={id}
          value={value}
          readOnly
          aria-describedby={`${id}-hint`}
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
          className={cn("min-w-0 flex-1 bg-muted/40 font-mono text-[13px] dark:bg-input/20", TOUCH)}
          data-testid={id}
        />
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={copyLabel}
          onClick={() => void copy(value)}
          className="shrink-0 max-md:size-11"
          data-testid={`${id}-copy`}
        >
          {done ? <Check /> : <Copy />}
        </Button>
        <span className="sr-only" aria-live="polite">
          {done ? "Copied" : ""}
        </span>
      </div>
    </FormField>
  );
}

/**
 * "Disconnect {n} members?" before a mode switch (UI-SPEC § 1): focus starts on Cancel; nothing is revoked at the
 * provider, so the copy promises only that the saved sign-ins and keys are deleted.
 */
function ClearConnectionsDialog({
  open,
  count,
  serverName,
  toMode,
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  count: number;
  serverName: string;
  toMode: ConnectorAuthMode;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const mode = AUTH_MODES.find((m) => m.value === toMode)?.label ?? toMode;
  return (
    <PlainDialog open={open} onOpenChange={(o) => !o && !pending && onCancel()}>
      <PlainDialogContent data-testid="mcp-clear-connections-confirm" initialFocus={cancelRef}>
        <PlainDialogHeader>
          <span className="mb-1 flex size-10 items-center justify-center rounded-xl border border-destructive/25 bg-destructive/10 text-destructive shadow-xs">
            <Unplug className="size-5" strokeWidth={1.75} aria-hidden />
          </span>
          <PlainDialogTitle>
            {count === 1 ? "Disconnect 1 member?" : `Disconnect ${count} members?`}
          </PlainDialogTitle>
          <PlainDialogDescription>
            Switching {serverName} to {mode} deletes every member's saved sign-in or key.{" "}
            {!isPerMemberMode(toMode)
              ? "Bots stop acting with members' own accounts."
              : "They'll need to connect again."}
          </PlainDialogDescription>
        </PlainDialogHeader>
        <PlainDialogFooter>
          <Button ref={cancelRef} variant="outline" onClick={onCancel} disabled={pending} className={TOUCH}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={pending}
            className={TOUCH}
            data-testid="mcp-clear-connections-submit"
          >
            {pending ? <Spinner /> : <Unplug />}
            Switch and disconnect {count}
          </Button>
        </PlainDialogFooter>
      </PlainDialogContent>
    </PlainDialog>
  );
}
