"use client";

import {
  type CreateMcpServerRequest,
  type McpHeaderInput,
  McpHeaderName,
  type McpServer,
  type McpServerList,
  type McpTransport,
  type UpdateMcpServerRequest,
} from "@ocw/contracts";
import { Lock, Plus, Save, ShieldCheck, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { errorMessage, isApiError } from "@/lib/api";
import { useCreateMcpServer, useUpdateMcpServer } from "@/lib/mcp-queries";
import { cn } from "@/lib/utils";

export const TRANSPORTS: Array<{ value: McpTransport; label: string; hint: string }> = [
  { value: "streamable-http", label: "Streamable HTTP", hint: "Most current MCP servers" },
  { value: "sse", label: "SSE (legacy)", hint: "Older servers with an /sse endpoint" },
  { value: "sandboxed-stdio", label: "Sandboxed stdio", hint: "A vetted local server in the sandbox" },
];

interface HeaderRow {
  key: number;
  name: string;
  value: string;
  /** A value is stored for this header (edit mode): it is kept unless the admin replaces it. */
  stored: boolean;
  replace: boolean;
}

type Errors = Partial<Record<"name" | "url" | "sandboxServer" | "form", string>> & {
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
  onOpenChange,
}: {
  open: boolean;
  /** Edit this server; null = add a new one. */
  server: McpServer | null;
  sandbox: McpServerList["sandbox"];
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="mcp-server-dialog" className="sm:max-w-lg">
        {open ? (
          <ServerForm
            key={server?.id ?? "new"}
            server={server}
            sandbox={sandbox}
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
  onDone,
}: {
  server: McpServer | null;
  sandbox: McpServerList["sandbox"];
  onDone: () => void;
}) {
  const create = useCreateMcpServer();
  const update = useUpdateMcpServer(server?.id ?? "");
  const editing = server !== null;
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
  const [errors, setErrors] = useState<Errors>({});
  const pending = create.isPending || update.isPending;
  const sandboxed = transport === "sandboxed-stdio";

  const patchHeader = (key: number, patch: Partial<HeaderRow>) => {
    setHeaders((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setErrors((e) => ({ ...e, headers: undefined, form: undefined }));
  };

  function validate(): Errors {
    const next: Errors = {};
    if (!name.trim()) next.name = "Give the server a name";
    if (!sandboxed && !url.trim()) next.url = "Enter the server's URL";
    if (sandboxed && !sandboxServer) next.sandboxServer = "Pick a vetted server";
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

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next = validate();
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    try {
      if (server) {
        const body: UpdateMcpServerRequest = {};
        if (name.trim() !== server.name) body.name = name.trim();
        if (!sandboxed && url.trim() !== (server.url ?? "")) body.url = url.trim();
        if (sandboxed && sandboxServer !== server.sandboxServer) body.sandboxServer = sandboxServer;
        const headersChanged =
          headers.length !== server.headers.length ||
          headers.some((h) => !h.stored || h.replace) ||
          headers.some((h, i) => h.name.trim() !== server.headers[i]?.name);
        if (headersChanged) body.headers = headerInputs();
        if (Object.keys(body).length > 0) await update.mutateAsync(body);
        toast.success(`${name.trim()} saved`, {
          description:
            body.url || body.headers || body.sandboxServer ? "Its tools are being checked again." : undefined,
        });
      } else {
        const body: CreateMcpServerRequest = {
          name: name.trim(),
          transport,
          ...(sandboxed ? { sandboxServer } : { url: url.trim() }),
          headers: headerInputs(),
          orgEnabled: true,
          personalAllowed: false,
          trustedChaining: false,
        };
        await create.mutateAsync(body);
        toast.success(`${body.name} added`, { description: "Your bots' runtime is discovering its tools." });
      }
      setHeaders([]);
      onDone();
    } catch (err) {
      const code = isApiError(err) ? err.code : "";
      const message = errorMessage(err);
      if (code === "invalid_url" || code === "url_required" || code === "url_not_allowed") {
        setErrors({ url: message });
      } else if (code === "unknown_sandbox_server" || code === "sandbox_unavailable") {
        setErrors({ sandboxServer: message });
      } else {
        setErrors({ form: message });
      }
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>{editing ? `Edit ${server.name}` : "Add an MCP server"}</DialogTitle>
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
                    "flex cursor-pointer items-start gap-2.5 rounded-lg border bg-card p-2.5 transition-colors sm:flex-col sm:gap-1",
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
                    onChange={() => setTransport(t.value)}
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
              className="font-mono text-[13px]"
              data-testid="mcp-url"
            />
          </FormField>
        )}

        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-sm">Headers</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={headers.length >= 8}
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
                        className={cn("font-mono text-[13px]", h.stored && "bg-muted/40")}
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
                            className="font-mono text-[13px]"
                            data-testid="mcp-header-value"
                          />
                        ) : (
                          <span className="flex h-9 items-center gap-2 rounded-md border border-dashed px-3 text-muted-foreground text-xs">
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
                            onClick={() => patchHeader(h.key, { replace: !h.replace, value: "" })}
                          >
                            {h.replace ? "Keep" : "Replace"}
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
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

        {errors.form ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-[13px] text-destructive"
            data-testid="mcp-form-error"
          >
            {errors.form}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending} data-testid="mcp-save">
          {pending ? <Spinner /> : editing ? <Save /> : <Plus />}
          {editing ? "Save" : "Add server"}
        </Button>
      </DialogFooter>
    </form>
  );
}
