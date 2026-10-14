"use client";

import { isAgentCardRoute, type MemberConnector } from "@ocw/contracts";
import { CircleAlert, CircleCheck, CircleDashed, CircleX, Plug, ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useIsDesktop } from "@/hooks/use-media-query";
import { isApiError } from "@/lib/api";
import {
  type ConnectorDisplayStatus,
  type ConnectorView,
  connectorErrorSentence,
  connectorView,
} from "@/lib/connections-format";
import { rememberConnectReturn, takeConnectReturn, useConnect, useConnectors } from "@/lib/connector-queries";
import { useCan } from "@/lib/permissions";
import { cn } from "@/lib/utils";

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

/** What the page shows after coming back from a provider (or after a failed start): inline, read on arrival (R8). */
type Banner =
  | { kind: "success"; serverId: string; back: string | null }
  | { kind: "error"; code: string; serverId: string | null };

/** The page's query parameters that describe a one-time arrival, removed from the URL once read. */
const ARRIVAL_PARAMS = ["connected", "error"] as const;

/**
 * Settings › Connections (07.4-13; D-01, CONN-01; UI-SPEC § 2, R1, R2, R8, R10): every per-member connector the
 * member may connect, one row each in exactly one state of the spec's table, connected through the provider's own
 * sign-in (a full-page redirect, never a popup) and back here with `?connected=` or `?error=`.
 */
export function ConnectionsSettings() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const q = useConnectors();
  const connect = useConnect();
  const desktopWidth = useIsDesktop();
  const canManageServers = useCan("mcp.manage");
  const [banner, setBanner] = useState<Banner | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  /** A chat route to come back to (`?return=`), only when it is an internal app route (T-07.4-13-04). */
  const returnParam = params.get("return");
  const returnRoute = returnParam && isAgentCardRoute(returnParam) ? returnParam : null;

  // One-time arrival: `?connected=<id>` / `?error=<code>[&connector=<id>]` become the banner, then leave the URL so a
  // reload shows neither.
  const arrival = useRef(false);
  useEffect(() => {
    if (arrival.current) return;
    arrival.current = true;
    const connected = params.get("connected");
    const error = params.get("error");
    if (!connected && !error) return;
    if (connected) setBanner({ kind: "success", serverId: connected, back: takeConnectReturn(connected) });
    else if (error) setBanner({ kind: "error", code: error, serverId: params.get("connector") });
    const rest = new URLSearchParams(params.toString());
    for (const p of ARRIVAL_PARAMS) rest.delete(p);
    if (error) rest.delete("connector");
    const qs = rest.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [params, pathname, router]);

  const connectors = q.data?.connectors ?? [];
  const oauth = q.data?.oauth ?? { oauthAvailable: false };
  const nameOf = (serverId: string | null) =>
    connectors.find((c) => c.serverId === serverId)?.name ?? "the connector";

  async function startConnect(c: MemberConnector) {
    setOpening(c.serverId);
    rememberConnectReturn(c.serverId, returnRoute);
    try {
      const { authorizeUrl } = await connect.mutateAsync(c.serverId);
      window.location.assign(authorizeUrl);
    } catch (err) {
      setOpening(null);
      setBanner({
        kind: "error",
        code: isApiError(err) ? err.code : "unknown",
        serverId: c.serverId,
      });
    }
  }

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
        <div>
          <p className="font-medium text-sm">No accounts to connect yet</p>
          <p className="mt-0.5 text-muted-foreground text-sm">
            When an admin adds a connector that uses your own account, it shows up here.
          </p>
        </div>
        {canManageServers ? (
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
            view={connectorView(c, oauth)}
            wide={desktopWidth}
            opening={opening === c.serverId}
            onConnect={() => void startConnect(c)}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-10 px-4 py-6 sm:px-6 sm:py-8">
      {banner ? (
        <ReturnBanner
          banner={banner}
          name={nameOf(banner.serverId)}
          onDismiss={() => setBanner(null)}
          onRetry={() => {
            const c = connectors.find((x) => x.serverId === banner.serverId);
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
        {list}
        <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
          <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
          Sign-ins and keys are encrypted on the server, never shown again and never given to bots. Every use
          is audited.
        </p>
      </section>
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

function ConnectorRow({
  connector: c,
  view,
  wide,
  opening,
  onConnect,
}: {
  connector: MemberConnector;
  view: ConnectorView;
  wide: boolean;
  opening: boolean;
  onConnect: () => void;
}) {
  const nameId = `connector-name-${c.serverId}`;
  const primary = view.primary ? (
    <Button
      size={wide ? "sm" : "default"}
      onClick={onConnect}
      disabled={view.primary.disabled || opening}
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
  ) : null;

  return (
    <li
      aria-labelledby={nameId}
      className="px-4 py-3 sm:px-5"
      data-testid={`connector-row-${c.serverId}`}
      data-status={view.status}
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
        </div>
        {wide && primary ? <div className="flex shrink-0 items-center gap-2">{primary}</div> : null}
      </div>
      {!wide && primary ? <div className="mt-3">{primary}</div> : null}
    </li>
  );
}

function primaryTestId(view: ConnectorView, serverId: string): string {
  return view.status === "needs_reconnect" || view.status === "revoked"
    ? `connector-reconnect-${serverId}`
    : `connector-connect-${serverId}`;
}

/**
 * Return banners (`connections-toast`): inline at the top of the page body so they are read on arrival. Success
 * offers `Back to chat` only with a validated return route; errors are one fixed sentence per code, never the
 * provider's text (T-07.4-13-02).
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
  const success = banner.kind === "success";
  const sentence = success ? null : connectorErrorSentence(banner.code, name);
  const back = success && banner.back && isAgentCardRoute(banner.back) ? banner.back : null;
  const Icon = success ? CircleCheck : CircleAlert;
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role={success ? "status" : "alert"}
      data-testid="connections-toast"
      data-kind={banner.kind}
      className={cn(
        "flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border px-4 py-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
        success ? "border-success/30 bg-success/8" : "border-destructive/30 bg-destructive/8",
      )}
    >
      <Icon
        className={cn("mt-0.5 size-4 shrink-0", success ? "text-success" : "text-destructive")}
        aria-hidden
      />
      <p className="min-w-0 flex-1 text-sm">
        {success ? `${name} connected. Ask your bot again.` : sentence?.text}
      </p>
      <div className="order-last flex w-full gap-2 pl-7 md:order-none md:w-auto md:pl-0">
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
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="-my-1 -mr-1 shrink-0 max-md:-my-2.5 max-md:-mr-2.5 max-md:size-11"
      >
        <X />
      </Button>
    </div>
  );
}
