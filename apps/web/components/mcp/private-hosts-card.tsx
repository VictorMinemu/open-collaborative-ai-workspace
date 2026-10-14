"use client";

import { PrivateHost, VAULT_LIMITS } from "@ocw/contracts";
import { Network, Plus, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { usePrivateHosts, useSavePrivateHosts } from "@/lib/keychain-queries";

const INVALID = "Use a host name or IP with an optional port, like erp.lan:8443";

/**
 * Private network hosts (07.4-13, UI-SPEC § 1 and R5; D-07 item 2): the organization's list of on-premises hosts that
 * unit keys may reach. An organization policy, so it lives on Settings › MCP servers, rendered only for callers holding
 * `bot.manage`; the API's own gate on `GET|PUT /keychain/private-hosts` is authoritative (T-07.4-13-06).
 */
export function PrivateHostsCard() {
  const q = usePrivateHosts();
  const save = useSavePrivateHosts();
  const [hosts, setHosts] = useState<string[] | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    if (q.data && hosts === null) setHosts(q.data.hosts);
  }, [q.data, hosts]);
  const current = hosts ?? [];
  const saved = q.data?.hosts ?? [];
  const changed =
    hosts !== null && (current.length !== saved.length || current.some((h, i) => h !== saved[i]));

  function add(e?: FormEvent) {
    e?.preventDefault();
    const parsed = PrivateHost.safeParse(draft);
    if (!parsed.success) {
      setError(INVALID);
      return;
    }
    if (current.includes(parsed.data)) {
      setError("Already listed");
      return;
    }
    if (current.length >= VAULT_LIMITS.privateHosts) {
      setError(`Up to ${VAULT_LIMITS.privateHosts} hosts`);
      return;
    }
    setHosts([...current, parsed.data]);
    setDraft("");
    setError(undefined);
  }

  async function onSave() {
    try {
      const res = await save.mutateAsync(current);
      setHosts(res.hosts);
      toast.success("Private network hosts saved");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section
      className="grid gap-3"
      aria-labelledby="mcp-private-hosts-heading"
      data-testid="mcp-private-hosts"
    >
      <div>
        <h2
          id="mcp-private-hosts-heading"
          className="flex items-center gap-2 font-semibold text-[15px] tracking-tight"
        >
          <Network className="size-4 text-muted-foreground" aria-hidden />
          Private network hosts
        </h2>
        <p className="mt-0.5 max-w-xl text-muted-foreground text-sm">
          Unit keys may reach these hosts on your network, like an on-premises ERP. Personal keys never can.
        </p>
      </div>
      <div className="grid gap-3 rounded-xl border bg-card p-4 shadow-xs">
        {q.isPending ? (
          <Skeleton className="h-9 rounded-md motion-reduce:animate-none" />
        ) : current.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="private-hosts-empty">
            No private hosts. Bots reach only public addresses.
          </p>
        ) : (
          <ul aria-label="Private network hosts" className="flex flex-wrap gap-1.5">
            {current.map((h) => (
              <li
                key={h}
                className="inline-flex h-7 max-w-full items-center gap-1 rounded-md border bg-background pr-0.5 pl-2 font-mono text-xs max-md:h-11"
                data-testid="private-host-chip"
                data-host={h}
              >
                <span className="truncate">{h}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${h}`}
                  onClick={() => setHosts(current.filter((x) => x !== h))}
                  className="size-6 max-md:size-11"
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={add} noValidate className="grid gap-1.5">
          <div className="flex gap-2">
            <Input
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(undefined);
              }}
              placeholder="erp.lan:8443"
              aria-label="Private network host"
              aria-invalid={!!error}
              aria-describedby={error ? "private-hosts-error" : "private-hosts-hint"}
              autoComplete="off"
              spellCheck={false}
              className="flex-1 font-mono text-[13px] max-md:h-11"
              data-testid="private-hosts-input"
            />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              className="h-9 max-md:h-11"
              data-testid="private-hosts-add"
            >
              <Plus /> Add
            </Button>
          </div>
          {error ? (
            <p id="private-hosts-error" role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          ) : (
            <p id="private-hosts-hint" className="text-muted-foreground text-xs">
              OCW's own services are always refused, even if listed.
            </p>
          )}
        </form>
        <div className="flex justify-end">
          <Button
            onClick={() => void onSave()}
            disabled={!changed || save.isPending}
            className="w-full sm:w-auto max-md:h-11"
            data-testid="private-hosts-save"
          >
            Save hosts
          </Button>
        </div>
      </div>
    </section>
  );
}
