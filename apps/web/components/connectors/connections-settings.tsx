"use client";

import { isAgentCardRoute, type MemberAccountShare, type MemberConnector } from "@ocw/contracts";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  ExternalLink,
  Info,
  MoreHorizontal,
  Plug,
  ShieldCheck,
  TriangleAlert,
  Unplug,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useIsDesktop } from "@/hooks/use-media-query";
import { errorMessage, isApiError } from "@/lib/api";
import { useDms } from "@/lib/chat-queries";
import {
  type ConnectorDisplayStatus,
  type ConnectorView,
  connectionDate,
  connectorErrorSentence,
  connectorView,
  conversationLabel,
  withdrawalView,
} from "@/lib/connections-format";
import {
  type PendingShare,
  rememberConnectReturn,
  rememberPendingShare,
  takeConnectReturn,
  takePendingShare,
  useConnect,
  useConnectors,
  useCreateShare,
  useDisconnect,
  useRevokeShare,
  useSharePreview,
  useShares,
} from "@/lib/connector-queries";
import { useDesktop } from "@/lib/desktop";
import { useVaultItem } from "@/lib/keychain-queries";
import { useCan } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { ConnectSecretDialog } from "./connect-secret-dialog";
import { SharedUseDialog, type ShareRequest } from "./shared-use-dialog";

/** 44 px touch targets below `md` (UI-SPEC: every control at 390). */
const TOUCH = "max-md:h-11";

const PILL: Record<ConnectorDisplayStatus, { icon: typeof CircleCheck; className: string }> = {
  not_connected: { icon: CircleDashed, className: "bg-muted text-muted-foreground" },
  unavailable: { icon: CircleDashed, className: "bg-muted text-muted-foreground" },
  connected: {
    icon: CircleCheck,
    className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300",
  },
  needs_reconnect: {
    icon: CircleAlert,
    className: "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
  },
  revoked: { icon: CircleX, className: "bg-red-100 text-red-800 dark:bg-red-400/15 dark:text-red-300" },
};

/** What the page shows after coming back from a provider, a failed start or a share link: inline, read on arrival. */
type Banner =
  | { kind: "success"; serverId: string; back: string | null }
  | { kind: "error"; code: string; serverId: string | null }
  | { kind: "notice"; tone: "info" | "error"; text: string };

/** Query parameters that describe a one-time arrival, removed from the URL once read. */
const ARRIVAL_PARAMS = ["connected", "error", "connect"] as const;
const SHARE_PARAMS = ["share", "key", "connector"] as const;

const sameConnector = (c: MemberConnector, ref: string) => c.serverId === ref || c.safeName === ref;

/**
 * Settings › Connections (07.4-13; D-01, D-03, CONN-01, CONN-03; UI-SPEC § 2, R1, R2, R7, R8, R10). Every per-member
 * connector the member may connect, one row each in exactly one state of the spec's table; connecting goes through the
 * provider's own sign-in (a full-page redirect, never a popup; in the desktop app, the system browser) and comes back
 * with `?connected=` or `?error=`. `?connector=` highlights a row, `?share=` asks before allowing an account or a key
 * in one conversation, and the allowed conversations are listed with an immediate Revoke.
 */
export function ConnectionsSettings() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const q = useConnectors();
  const shares = useShares();
  const dms = useDms();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const createShare = useCreateShare();
  const revokeShare = useRevokeShare();
  const wide = useIsDesktop();
  const desktopApp = useDesktop();
  const canManageServers = useCan("mcp.manage");
  const [banner, setBanner] = useState<Banner | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [keyDialog, setKeyDialog] = useState<{ connector: MemberConnector; mode: "add" | "replace" } | null>(
    null,
  );
  const [toDisconnect, setToDisconnect] = useState<MemberConnector | null>(null);
  const [highlightRef, setHighlightRef] = useState<string | null>(null);
  const [highlightShare, setHighlightShare] = useState<string | null>(null);
  const [share, setShare] = useState<PendingShare | null>(null);
  const [autoConnect, setAutoConnect] = useState<string | null>(null);
  /** A chat route to come back to (`?return=`), only when it is an internal app route (T-07.4-13-04). */
  const returnParam = params.get("return");
  const returnRoute = returnParam && isAgentCardRoute(returnParam) ? returnParam : null;

  const replaceParams = (drop: readonly string[]) => {
    const rest = new URLSearchParams(window.location.search);
    for (const p of drop) rest.delete(p);
    const qs = rest.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // One-time arrival. `?connected=<id>` / `?error=<code>[&connector=<id>]` become the banner (a share link that waited
  // for the connect reopens), `?connect=<id>` starts the flow once (desktop hand-off), `?connector=` highlights a row
  // and `?share=` asks before allowing. The one-time parameters then leave the URL, so a reload repeats none of them.
  const arrival = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once per page load by design
  useEffect(() => {
    if (arrival.current) return;
    arrival.current = true;
    const connected = params.get("connected");
    const error = params.get("error");
    const drop: string[] = [];
    if (connected) {
      setBanner({ kind: "success", serverId: connected, back: takeConnectReturn(connected) });
      const pending = takePendingShare();
      if (pending) setShare(pending);
    } else if (error) {
      setBanner({ kind: "error", code: error, serverId: params.get("connector") });
      takePendingShare();
      drop.push("connector");
    } else if (params.get("connector") && !params.get("share")) {
      setHighlightRef(params.get("connector"));
    }
    if (params.get("connect")) setAutoConnect(params.get("connect"));
    const shareParam = params.get("share");
    if (shareParam && !connected) {
      setShare({ share: shareParam, connector: params.get("connector"), key: params.get("key") });
    }
    for (const p of ARRIVAL_PARAMS) if (params.get(p) !== null) drop.push(p);
    if (drop.length > 0) replaceParams(drop);
  }, []);

  const connectors = q.data?.connectors ?? [];
  const oauth = q.data?.oauth ?? { oauthAvailable: false };
  /**
   * Connecting is denied (Bots off, or a `connector.connect` deny rule; WINDOWS #196): the API lists only the member's
   * own connections, and each row offers Disconnect only, as the API always allows withdrawal.
   */
  const withdrawOnly = q.data?.canConnect === false;
  const viewOf = (c: MemberConnector) =>
    withdrawOnly ? withdrawalView(connectorView(c, oauth)) : connectorView(c, oauth);
  const activeShares = shares.data?.shares ?? [];
  const nameOf = (serverId: string | null) =>
    connectors.find((c) => c.serverId === serverId)?.name ?? "the connector";
  const labelOf = (conversationId: string, apiName: string | null) =>
    conversationLabel(conversationId, apiName, dms.data?.dms);

  async function startConnect(c: MemberConnector) {
    setOpening(c.serverId);
    rememberConnectReturn(c.serverId, returnRoute);
    try {
      const { authorizeUrl } = await connect.mutateAsync(c.serverId);
      window.location.assign(authorizeUrl);
    } catch (err) {
      setOpening(null);
      setBanner({ kind: "error", code: isApiError(err) ? err.code : "unknown", serverId: c.serverId });
    }
  }

  // `?connect=<id>` (the desktop app's hand-off target): starts the flow once per page load, never in the desktop app.
  const autoStarted = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: startConnect is stable for this purpose
  useEffect(() => {
    if (!autoConnect || autoStarted.current || !q.data || desktopApp || withdrawOnly) return;
    autoStarted.current = true;
    const c = connectors.find((x) => sameConnector(x, autoConnect));
    if (c?.authMode !== "per_member_oauth") return;
    if (connectorView(c, oauth).primary?.disabled) return;
    void startConnect(c);
  }, [autoConnect, q.data, desktopApp]);

  // `?connector=`: the row scrolls into view and its primary action takes the focus; the ring stays until the first
  // pointer or key interaction (no pulse: reduced motion is respected by construction).
  const highlighted = highlightRef
    ? connectors.find((c) => sameConnector(c, highlightRef))?.serverId
    : undefined;
  useEffect(() => {
    if (!highlighted) return;
    const row = document.querySelector<HTMLElement>(`[data-testid="connector-row-${highlighted}"]`);
    row?.scrollIntoView({ block: "center", behavior: "auto" });
    row?.querySelector<HTMLElement>("[data-primary], button, a[href]")?.focus({ preventScroll: true });
    const clear = () => setHighlightRef(null);
    const t = window.setTimeout(() => {
      window.addEventListener("pointerdown", clear, { once: true });
      window.addEventListener("keydown", clear, { once: true });
    }, 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("pointerdown", clear);
      window.removeEventListener("keydown", clear);
    };
  }, [highlighted]);

  // ---- the share link (R7): resolve the resource, then the readers, then ask
  const shareConnector = share?.connector
    ? connectors.find((c) => sameConnector(c, share.connector ?? ""))
    : null;
  const vaultItem = useVaultItem(share?.key ?? null);
  const preview = useSharePreview(share && !share.key && !share.connector ? null : (share?.share ?? null));
  const closeShare = () => {
    setShare(null);
    replaceParams(SHARE_PARAMS);
  };
  let request: ShareRequest | null = null;
  if (share && q.data && shares.data) {
    if (share.key && vaultItem.data && vaultItem.data.scope === "personal") {
      request = {
        conversationId: share.share,
        resourceKind: "vault_item",
        resourceId: vaultItem.data.id,
        resourceName: vaultItem.data.name,
        connected: true,
      };
    } else if (!share.key && shareConnector) {
      request = {
        conversationId: share.share,
        resourceKind: "connector",
        resourceId: shareConnector.serverId,
        resourceName: shareConnector.name,
        connected: shareConnector.status === "connected",
      };
    }
  }
  const shareConversation = request
    ? labelOf(request.conversationId, preview.data?.conversationName ?? null)
    : "";
  const existing = request
    ? activeShares.find(
        (s) => s.conversationId === request?.conversationId && s.resourceId === request.resourceId,
      )
    : undefined;
  // Unknown ids are ignored silently; an unreadable conversation and an existing share are said once, without a dialog.
  const shareSettled = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: closeShare and labelOf read current state
  useEffect(() => {
    if (!share || !q.data || !shares.data) return;
    const id = `${share.share}:${share.connector ?? ""}:${share.key ?? ""}`;
    if (shareSettled.current === id) return;
    if (withdrawOnly) {
      shareSettled.current = id;
      setBanner({
        kind: "notice",
        tone: "info",
        text: "Connecting accounts is turned off for you, so nothing can be allowed in a conversation.",
      });
      closeShare();
      return;
    }
    const unknownResource = share.key ? vaultItem.isError : !shareConnector;
    if (unknownResource || (!share.key && !share.connector)) {
      shareSettled.current = id;
      closeShare();
      return;
    }
    if (preview.isError) {
      shareSettled.current = id;
      setBanner({ kind: "notice", tone: "error", text: "That conversation isn't available to you." });
      closeShare();
      return;
    }
    if (existing && preview.data) {
      shareSettled.current = id;
      setBanner({
        kind: "notice",
        tone: "info",
        text: `${existing.resourceName} is already allowed in ${labelOf(existing.conversationId, existing.conversationName)}.`,
      });
      setHighlightShare(existing.id);
      closeShare();
    }
  }, [
    share,
    q.data,
    shares.data,
    vaultItem.isError,
    shareConnector,
    preview.isError,
    preview.data,
    existing,
    withdrawOnly,
  ]);
  const dialogRequest = request && !existing && !preview.isError && !withdrawOnly ? request : null;

  async function confirmShare() {
    if (!dialogRequest) return;
    const conversation = shareConversation;
    try {
      const created = await createShare.mutateAsync({
        conversationId: dialogRequest.conversationId,
        resourceKind: dialogRequest.resourceKind,
        resourceId: dialogRequest.resourceId,
      });
      toast.success(`${dialogRequest.resourceName} allowed in ${conversation}`);
      setHighlightShare(created.id);
      closeShare();
    } catch (err) {
      if (isApiError(err, 409)) {
        setBanner({
          kind: "notice",
          tone: "info",
          text: `${dialogRequest.resourceName} is already allowed in ${conversation}.`,
        });
        closeShare();
      } else if (isApiError(err, 404)) {
        setBanner({ kind: "notice", tone: "error", text: "That conversation isn't available to you." });
        closeShare();
      } else {
        toast.error(errorMessage(err));
      }
    }
  }

  function connectThenShare() {
    if (!share || !shareConnector) return;
    rememberPendingShare(share);
    setShare(null);
    if (shareConnector.authMode === "per_member_secret") {
      setKeyDialog({ connector: shareConnector, mode: "add" });
      return;
    }
    void startConnect(shareConnector);
  }

  async function confirmDisconnect() {
    if (!toDisconnect) return;
    try {
      await disconnect.mutateAsync(toDisconnect.serverId);
      toast.success(`${toDisconnect.name} disconnected`);
      setToDisconnect(null);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function revoke(s: MemberAccountShare) {
    const conversation = labelOf(s.conversationId, s.conversationName);
    try {
      await revokeShare.mutateAsync(s.id);
      toast.success(`${s.resourceName} is no longer used in ${conversation}.`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const httpsNotice =
    q.data && !oauth.oauthAvailable && connectors.some((c) => c.authMode === "per_member_oauth");

  let list: ReactNode;
  if (q.isPending) {
    list = (
      <div className="divide-y rounded-xl border bg-card shadow-xs" aria-busy>
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex h-[72px] items-center gap-3 px-4 sm:px-5">
            <Skeleton className="size-9 rounded-lg motion-reduce:animate-none" />
            <div className="grid flex-1 gap-2">
              <Skeleton className="h-3.5 w-40 motion-reduce:animate-none" />
              <Skeleton className="h-3 w-64 max-w-full motion-reduce:animate-none" />
            </div>
          </div>
        ))}
      </div>
    );
  } else if (q.isError) {
    list = (
      <div className="rounded-xl border bg-card">
        {isApiError(q.error) && !q.error.isNetwork ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center text-sm" role="alert">
            <p>Couldn't load your connections.</p>
            <Button variant="outline" size="sm" onClick={() => q.refetch()} className={TOUCH}>
              Try again
            </Button>
          </div>
        ) : (
          <ServerUnreachable onRetry={() => q.refetch()} retrying={q.isFetching} />
        )}
      </div>
    );
  } else if (connectors.length === 0) {
    list = (
      <div
        className="flex flex-col items-center gap-3 rounded-2xl border border-dashed px-6 py-12 text-center"
        data-testid="connections-empty"
      >
        <span className="flex size-11 items-center justify-center rounded-xl border bg-muted/50">
          <Plug className="size-5 text-muted-foreground" aria-hidden />
        </span>
        {withdrawOnly ? (
          <p className="font-medium text-sm">No connected accounts</p>
        ) : (
          <div>
            <p className="font-medium text-sm">No accounts to connect yet</p>
            <p className="mt-0.5 text-muted-foreground text-sm">
              When an admin adds a connector that uses your own account, it shows up here.
            </p>
          </div>
        )}
        {canManageServers && !withdrawOnly ? (
          <Link
            href="/settings/mcp-servers"
            className="inline-flex min-h-11 items-center font-medium text-primary text-sm hover:underline md:min-h-0"
          >
            Add one in MCP servers
          </Link>
        ) : null}
      </div>
    );
  } else {
    list = (
      <ul
        aria-label="Your accounts"
        className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs"
        data-testid="connections-list"
      >
        {connectors.map((c) => (
          <ConnectorRow
            key={c.serverId}
            connector={c}
            view={viewOf(c)}
            wide={wide}
            desktopApp={desktopApp !== null}
            opening={opening === c.serverId}
            highlighted={highlighted === c.serverId}
            onPrimary={() => {
              const v = viewOf(c);
              if (v.primary?.kind === "key") setKeyDialog({ connector: c, mode: "add" });
              else void startConnect(c);
            }}
            onReplace={() => setKeyDialog({ connector: c, mode: "replace" })}
            onDisconnect={() => setToDisconnect(c)}
          />
        ))}
      </ul>
    );
  }

  const disconnectShares = toDisconnect
    ? activeShares.filter((s) => s.resourceKind === "connector" && s.resourceId === toDisconnect.serverId)
    : [];

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-10 px-4 py-6 sm:px-6 sm:py-8">
      {banner ? (
        <ReturnBanner
          banner={banner}
          name={banner.kind === "notice" ? "" : nameOf(banner.serverId)}
          onDismiss={() => setBanner(null)}
          onRetry={() => {
            const c = banner.kind === "error" ? connectors.find((x) => x.serverId === banner.serverId) : null;
            setBanner(null);
            if (c) void startConnect(c);
          }}
          onBack={(route) => router.push(route)}
        />
      ) : null}

      <section className="grid gap-3" aria-labelledby="connections-accounts-heading">
        <div>
          <h2 id="connections-accounts-heading" className="font-semibold text-[15px] tracking-tight">
            Your accounts
          </h2>
          <p className="mt-0.5 text-muted-foreground text-sm">
            Connect your own accounts so bots can act for you. What a bot reads with your account stays in
            your private chats unless you allow a conversation.
          </p>
        </div>
        {withdrawOnly ? (
          <p
            role="note"
            className="flex items-start gap-2.5 rounded-xl border bg-muted/40 px-4 py-3 text-sm"
            data-testid="connections-withdraw-only"
          >
            <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span>
              Connecting accounts is turned off for you. You can still disconnect the accounts you connected
              and revoke where you allowed them.
            </span>
          </p>
        ) : null}
        {httpsNotice && !withdrawOnly ? (
          <p
            role="note"
            className="flex items-start gap-2.5 rounded-xl border border-warning/30 bg-warning/8 px-4 py-3 text-sm"
            data-testid="connections-https-required"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <span>
              Signing in to connectors needs HTTPS on this workspace. Ask an admin to set it up. Key
              connectors still work.
            </span>
          </p>
        ) : null}
        {list}
      </section>

      {activeShares.length > 0 ? (
        <section className="grid gap-3" aria-labelledby="connections-shares-heading">
          <div>
            <h2 id="connections-shares-heading" className="font-semibold text-[15px] tracking-tight">
              Allowed in shared conversations
            </h2>
            <p className="mt-0.5 text-muted-foreground text-sm">
              Bots there can act with your account when you ask. Revoke any time.
            </p>
          </div>
          <ul
            aria-label="Allowed in shared conversations"
            className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs"
            data-testid="shares-list"
          >
            {activeShares.map((s) => (
              <ShareRow
                key={s.id}
                share={s}
                conversation={labelOf(s.conversationId, s.conversationName)}
                highlighted={highlightShare === s.id}
                pending={revokeShare.isPending && revokeShare.variables === s.id}
                onRevoke={() => void revoke(s)}
              />
            ))}
          </ul>
        </section>
      ) : null}

      <p className="-mt-7 flex items-start gap-1.5 text-muted-foreground text-xs">
        <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
        Sign-ins and keys are encrypted on the server, never shown again and never given to bots. Every use is
        audited.
      </p>

      <ConnectSecretDialog
        connector={keyDialog?.connector ?? null}
        mode={keyDialog?.mode ?? "add"}
        onOpenChange={(o) => {
          if (o) return;
          setKeyDialog(null);
          // A share link that waited for this key reopens once the key is saved.
          const pending = takePendingShare();
          if (pending) setShare(pending);
        }}
      />

      <SharedUseDialog
        request={dialogRequest}
        conversation={shareConversation}
        preview={preview.data}
        pending={createShare.isPending || (dialogRequest !== null && opening === dialogRequest.resourceId)}
        onCancel={closeShare}
        onConfirm={() => void confirmShare()}
        onConnect={connectThenShare}
      />

      <DisconnectDialog
        connector={toDisconnect}
        shares={disconnectShares.map((s) => labelOf(s.conversationId, s.conversationName))}
        pending={disconnect.isPending}
        onCancel={() => setToDisconnect(null)}
        onConfirm={() => void confirmDisconnect()}
      />
    </div>
  );
}

/** Status pill (UI-SPEC § Color › Connection state): the text is always written out, colour only reinforces it. */
export function ConnectorPill({ view, serverId }: { view: ConnectorView; serverId: string }) {
  const p = PILL[view.status];
  const Icon = p.icon;
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 font-semibold text-xs",
        p.className,
      )}
      data-testid={`connector-status-${serverId}`}
    >
      <Icon className="size-3.5" aria-hidden />
      {view.pill}
    </span>
  );
}

function primaryTestId(view: ConnectorView, serverId: string): string {
  return view.status === "needs_reconnect" || view.status === "revoked"
    ? `connector-reconnect-${serverId}`
    : `connector-connect-${serverId}`;
}

function ConnectorRow({
  connector: c,
  view,
  wide,
  desktopApp,
  opening,
  highlighted,
  onPrimary,
  onReplace,
  onDisconnect,
}: {
  connector: MemberConnector;
  view: ConnectorView;
  wide: boolean;
  desktopApp: boolean;
  opening: boolean;
  highlighted: boolean;
  onPrimary: () => void;
  onReplace: () => void;
  onDisconnect: () => void;
}) {
  const nameId = `connector-name-${c.serverId}`;
  // In the desktop app the provider's sign-in must run where the member is signed in to the web app: the system
  // browser (Pitfall 7). The link opens this page there, which starts the flow once (`?connect=`).
  const handOff = desktopApp && view.primary?.kind === "connect" && !view.primary.disabled;
  let primary: ReactNode = null;
  if (view.primary && handOff) {
    primary = (
      <a
        href={`${window.location.origin}/settings/connections?connect=${c.serverId}`}
        target="_blank"
        rel="noopener noreferrer"
        data-primary
        data-testid={primaryTestId(view, c.serverId)}
        className={cn(buttonVariants({ size: wide ? "sm" : "default" }), !wide && "h-11 w-full")}
      >
        {view.primary.label === "Reconnect" ? "Reconnect in browser" : "Connect in browser"}
        <ExternalLink className="size-3.5" aria-hidden />
      </a>
    );
  } else if (view.primary) {
    primary = (
      <Button
        size={wide ? "sm" : "default"}
        onClick={onPrimary}
        disabled={view.primary.disabled || opening}
        data-primary
        data-testid={primaryTestId(view, c.serverId)}
        className={cn(!wide && "h-11 w-full")}
      >
        {opening ? (
          <>
            <Spinner /> Opening {c.name}…
          </>
        ) : (
          view.primary.label
        )}
      </Button>
    );
  }

  const secondary = wide ? (
    <>
      {view.secondary.includes("replace") ? (
        <Button
          variant="outline"
          size="sm"
          onClick={onReplace}
          data-testid={`connector-replace-${c.serverId}`}
        >
          Replace key
        </Button>
      ) : null}
      {view.secondary.includes("disconnect") ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={onDisconnect}
          data-testid={`connector-disconnect-${c.serverId}`}
        >
          Disconnect
        </Button>
      ) : null}
    </>
  ) : view.secondary.length > 0 ? (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="-my-1.5 -mr-2 size-11 shrink-0 text-muted-foreground"
            aria-label={`${c.name} actions`}
            data-testid={`connector-menu-${c.serverId}`}
          />
        }
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {view.secondary.includes("replace") ? (
          <DropdownMenuItem
            onClick={onReplace}
            className="min-h-11"
            data-testid={`connector-replace-${c.serverId}`}
          >
            Replace key
          </DropdownMenuItem>
        ) : null}
        {view.secondary.includes("disconnect") ? (
          <DropdownMenuItem
            onClick={onDisconnect}
            variant="destructive"
            className="min-h-11"
            data-testid={`connector-disconnect-${c.serverId}`}
          >
            <Unplug /> Disconnect
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  return (
    <li
      aria-labelledby={nameId}
      className={cn("px-4 py-3 sm:px-5", highlighted && "ring-2 ring-primary/60 ring-inset")}
      data-testid={`connector-row-${c.serverId}`}
      data-status={view.status}
      data-highlighted={highlighted || undefined}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground"
        >
          <Plug className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-x-2">
            <span id={nameId} className="truncate font-semibold text-sm">
              {c.name}
            </span>
            <span className="shrink-0 text-muted-foreground text-xs">
              <span aria-hidden className="md:hidden">
                ·{" "}
              </span>
              {view.modeLabel}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <ConnectorPill view={view} serverId={c.serverId} />
            <span className="text-muted-foreground text-xs" data-testid={`connector-meta-${c.serverId}`}>
              {view.meta}
            </span>
          </div>
          {handOff ? (
            <p
              className="mt-1 text-muted-foreground text-xs"
              data-testid={`connector-desktop-hint-${c.serverId}`}
            >
              Opens your browser, where you're signed in to OCW.
            </p>
          ) : null}
        </div>
        {wide ? (
          primary || secondary ? (
            <div className="flex shrink-0 items-center gap-2">
              {secondary}
              {primary}
            </div>
          ) : null
        ) : (
          secondary
        )}
      </div>
      {!wide && primary ? <div className="mt-3">{primary}</div> : null}
    </li>
  );
}

function ShareRow({
  share: s,
  conversation,
  highlighted,
  pending,
  onRevoke,
}: {
  share: MemberAccountShare;
  conversation: string;
  highlighted: boolean;
  pending: boolean;
  onRevoke: () => void;
}) {
  const readers = s.readersAtGrant === 1 ? "1 person could read" : `${s.readersAtGrant} people could read`;
  return (
    <li
      className={cn(
        "flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:px-5",
        highlighted && "ring-2 ring-primary/60 ring-inset",
      )}
      data-testid={`share-row-${s.id}`}
    >
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-sm">
          {s.resourceName} in {conversation}
        </p>
        <p className="mt-0.5 flex items-center gap-1.5 text-muted-foreground text-xs">
          <Users className="size-3.5 shrink-0" aria-hidden />
          {readers} · allowed {connectionDate(s.grantedAt)}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onRevoke}
        disabled={pending}
        className="h-11 w-full sm:h-8 sm:w-auto"
        data-testid={`share-revoke-${s.id}`}
        aria-label={`Revoke ${s.resourceName} in ${conversation}`}
      >
        {pending ? <Spinner /> : null}
        Revoke
      </Button>
    </li>
  );
}

/** Disconnect confirmation (UI-SPEC § 2): revokes at the provider, deletes locally, and ends the connector's shares. */
function DisconnectDialog({
  connector: c,
  shares,
  pending,
  onCancel,
  onConfirm,
}: {
  connector: MemberConnector | null;
  shares: string[];
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const key = c?.authMode === "per_member_secret";
  const sharedIn =
    shares.length === 0
      ? null
      : shares.length === 1
        ? `It stops being used in ${shares[0]}.`
        : `It stops being used in ${shares[0]} and ${shares.length - 1} other ${
            shares.length === 2 ? "conversation" : "conversations"
          }.`;
  return (
    <Dialog open={c !== null} onOpenChange={(o) => !o && !pending && onCancel()}>
      <DialogContent data-testid="connections-disconnect-dialog" initialFocus={cancelRef}>
        {c ? (
          <>
            <DialogHeader>
              <span className="mb-1 flex size-10 items-center justify-center rounded-xl border border-destructive/25 bg-destructive/10 text-destructive shadow-xs">
                <Unplug className="size-5" strokeWidth={1.75} aria-hidden />
              </span>
              <DialogTitle>Disconnect {c.name}?</DialogTitle>
              <DialogDescription render={<div />} className="grid gap-2">
                <p>
                  {key
                    ? `Bots can no longer act with your ${c.name} account. Your key is deleted from this workspace.`
                    : `Bots can no longer act with your ${c.name} account. Your sign-in is revoked at ${c.name} and removed from this workspace.`}
                </p>
                {sharedIn ? <p data-testid="connections-disconnect-shares">{sharedIn}</p> : null}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                ref={cancelRef}
                variant="outline"
                onClick={onCancel}
                disabled={pending}
                className={TOUCH}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={onConfirm}
                disabled={pending}
                className={TOUCH}
                data-testid="connections-disconnect-confirm"
              >
                {pending ? <Spinner /> : null}
                Disconnect
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Return banners (`connections-toast`): inline at the top of the page body so they are read on arrival (focused).
 * Success offers `Back to chat` only with a validated return route; errors are one fixed sentence per code, never the
 * provider's text (T-07.4-13-02); notices are the share link's outcomes.
 */
function ReturnBanner({
  banner,
  name,
  onDismiss,
  onRetry,
  onBack,
}: {
  banner: Banner;
  name: string;
  onDismiss: () => void;
  onRetry: () => void;
  onBack: (route: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const tone = banner.kind === "success" ? "success" : banner.kind === "error" ? "error" : banner.tone;
  const sentence = banner.kind === "error" ? connectorErrorSentence(banner.code, name) : null;
  const text =
    banner.kind === "success"
      ? `${name} connected. Ask your bot again.`
      : banner.kind === "error"
        ? sentence?.text
        : banner.text;
  const back = banner.kind === "success" && banner.back && isAgentCardRoute(banner.back) ? banner.back : null;
  const Icon = tone === "success" ? CircleCheck : tone === "error" ? CircleAlert : Info;
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role={tone === "error" ? "alert" : "status"}
      data-testid="connections-toast"
      data-kind={banner.kind === "notice" ? `notice-${banner.tone}` : banner.kind}
      className={cn(
        "flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border px-4 py-3 outline-none",
        tone === "success" && "border-success/30 bg-success/8",
        tone === "error" && "border-destructive/30 bg-destructive/8",
        tone === "info" && "bg-muted/40",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "success" && "text-success",
          tone === "error" && "text-destructive",
          tone === "info" && "text-muted-foreground",
        )}
        aria-hidden
      />
      <p className="min-w-0 flex-1 text-sm" data-testid="connections-toast-text">
        {text}
      </p>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="-my-1 -mr-1 shrink-0 md:order-last max-md:-my-2.5 max-md:-mr-2.5 max-md:size-11"
      >
        <X />
      </Button>
      {back || sentence?.retry ? (
        <div className="flex w-full gap-2 md:w-auto max-md:pl-7">
          {back ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onBack(back)}
              className="h-11 flex-1 md:h-8 md:flex-none"
              data-testid="connections-back-to-chat"
            >
              Back to chat
            </Button>
          ) : null}
          {sentence?.retry ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onRetry}
              className="h-11 flex-1 md:h-8 md:flex-none"
              data-testid="connections-try-again"
            >
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
