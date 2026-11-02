"use client";

import type {
  PreviewWatchedRecordResponse,
  UpdateWatchedRecordRequest,
  WatchedCheckInterval,
  WatchedField,
  WatchedRecord,
  WatchOptionConnector,
  WatchOptions,
} from "@ocw/contracts";
import { ArrowUpRight, ChevronDown, ChevronRight, Info, Trash2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { Tooltip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api";
import { useBoard } from "@/lib/board-queries";
import { rememberConnectReturn } from "@/lib/connector-queries";
import { cn } from "@/lib/utils";
import {
  CHECK_INTERVALS,
  connectHref,
  connectorLabel,
  fieldsError,
  preselectedPointers,
  shareHref,
  shareNotice,
  useCreateWatch,
  useUpdateWatch,
  useWatchOptions,
  useWatchPreview,
  watchRefusal,
} from "@/lib/watched-queries";

/**
 * Watch an external record (07.6-17, AUTO-04, D-04, D-07, UI-SPEC Surface 7a, R9, Pitfall 8): links a 07.1 board card to
 * a record read through a 07.4 connector. Connector (only those the API offers for this board: a read-only tool one of
 * the board's bots may use), Record ID + Find (reads it once, nothing stored), the fields to watch with their current
 * values, how often, which bot reports, and Advanced tools. A per-member connector without the viewer's share on this
 * board shows the amber notice with the Allow link to the 07.4 shared-use dialog
 * (`/settings/connections?share=<board>&connector=<id>`, `shareHref`), and Start watching stays
 * `aria-disabled` with that notice as its description: the API's 409 `member_account` is the authority either way.
 * Every record value is plain text (React text nodes, truncated with a Tooltip). Edit mode keeps Connector and Record
 * ID read-only and offers Stop watching…
 */

type Mode = "new" | "edit";

const TOUCH = "max-md:h-11";
const NUMBER_HINT = "Money and large numbers are safer as text fields.";
const NO_CONNECTORS = "No connectors can read records yet. Ask an admin to add one in MCP servers.";

export interface WatchRecordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  card: { messageId: string; conversationId: string };
  mode?: Mode;
  /** The card's watch (edit mode). */
  watch?: WatchedRecord | null;
  /** Edit mode: opens the Stop watching confirmation (the dialog closes first). */
  onStopWatching?: () => void;
}

export function WatchRecordDialog({ open, onOpenChange, ...props }: WatchRecordDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="watch-record-dialog"
        className="sm:max-w-lg max-sm:inset-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:rounded-none"
      >
        <WatchForm {...props} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/** Read tools a bot of the board may use (read-only, non-destructive); `get_*` first (the default). */
export function readTools(c: WatchOptionConnector | undefined) {
  const tools = (c?.tools ?? []).filter((t) => t.readOnly && !t.destructive && t.agentIds.length > 0);
  return [...tools].sort((a, b) => Number(b.name.startsWith("get_")) - Number(a.name.startsWith("get_")));
}

/** Tools that change the record (Update with / Add notes with), offered only when the reporting bot may use them. */
export function writeTools(c: WatchOptionConnector | undefined, agentId: string) {
  return (c?.tools ?? []).filter((t) => !t.readOnly && t.agentIds.includes(agentId));
}

/** The connector selected by default: the first one the viewer can use now. */
export function defaultConnector(options: WatchOptions | undefined): WatchOptionConnector | undefined {
  const list = options?.connectors ?? [];
  return list.find((c) => c.authMode === "org_secret" || c.connection === "connected") ?? list[0];
}

type Errors = Partial<Record<"recordId" | "fields" | "bot" | "form", string>>;

function WatchForm({
  card,
  mode = "new",
  watch = null,
  onStopWatching,
  onDone,
}: Omit<WatchRecordDialogProps, "open" | "onOpenChange"> & { onDone: () => void }) {
  const edit = mode === "edit" && watch !== null;
  const uid = useId();
  const id = (k: string) => `${uid}-${k}`;
  const options = useWatchOptions(card.conversationId, true);
  const board = useBoard(card.conversationId);
  const preview = useWatchPreview();
  const create = useCreateWatch(card.conversationId);
  const update = useUpdateWatch(card.conversationId);

  const [connectorId, setConnectorId] = useState<string>(watch?.connector.id ?? "");
  const [recordId, setRecordId] = useState(watch?.externalRef ?? "");
  const [found, setFound] = useState<PreviewWatchedRecordResponse | null>(null);
  const [selected, setSelected] = useState<string[]>(watch?.fields.map((f) => f.pointer) ?? []);
  const [interval, setIntervalMinutes] = useState<WatchedCheckInterval>(watch?.checkIntervalMinutes ?? 60);
  const [agentId, setAgentId] = useState(watch?.agent.id ?? "");
  const [advanced, setAdvanced] = useState(false);
  const [readTool, setReadTool] = useState(watch?.readTool ?? "");
  const [idArg, setIdArg] = useState(watch?.idArg ?? "");
  const [writeTool, setWriteTool] = useState(watch?.writeTool ?? "");
  const [noteTool, setNoteTool] = useState(watch?.noteTool ?? "");
  const [errors, setErrors] = useState<Errors>({});
  const [shareRefused, setShareRefused] = useState(false);

  const opts = options.data;
  const channel = opts?.channel.name ?? "channel";
  const connector =
    opts?.connectors.find((c) => c.id === connectorId) ??
    (edit || connectorId ? undefined : defaultConnector(opts));
  const effectiveConnectorId = connector?.id ?? connectorId;
  const reads = readTools(connector);
  const tool = reads.find((t) => t.name === readTool) ?? (edit ? undefined : reads[0]);
  const effectiveReadTool = tool?.name ?? readTool;
  const effectiveIdArg = idArg || tool?.idArg || "id";
  const name = connector?.name ?? watch?.connector.name ?? "the connector";
  const usable = connector
    ? connector.authMode === "org_secret" || connector.connection === "connected"
    : edit;
  const needsShare =
    !!connector && connector.authMode === "per_member" && usable && (!connector.shared || shareRefused);
  const bots = opts?.bots ?? [];
  const botFor = (a: string) => tool?.agentIds.includes(a) ?? true;
  const agent = bots.find((b) => b.id === agentId) ?? (edit ? undefined : bots.find((b) => botFor(b.id)));
  const effectiveAgentId = agent?.id ?? agentId;
  const updates = writeTools(connector, effectiveAgentId);

  // Edit mode reads the record once on open, to show each field's current value.
  const loaded = useRef(false);
  useEffect(() => {
    if (!edit || loaded.current || !watch) return;
    loaded.current = true;
    preview.mutate(
      {
        conversationId: card.conversationId,
        mcpServerId: watch.connector.id,
        externalRef: watch.externalRef,
        readTool: watch.readTool,
        idArg: watch.idArg,
      },
      { onSuccess: setFound },
    );
  }, [edit, watch, card.conversationId, preview]);

  const fieldRows = useMemo(() => {
    const rows = (found?.values ?? []).map((v) => ({
      pointer: v.pointer,
      label: v.suggestedLabel,
      value: v.value,
    }));
    for (const f of watch?.fields ?? []) {
      if (!rows.some((r) => r.pointer === f.pointer))
        rows.push({ pointer: f.pointer, label: f.label, value: null });
    }
    return rows;
  }, [found, watch]);

  const resetFound = () => {
    setFound(null);
    setSelected([]);
    setErrors({});
  };

  const find = () => {
    const ref = recordId.trim();
    if (!connector || !ref || !effectiveReadTool) {
      setErrors({ recordId: ref ? undefined : "Enter the record's ID" });
      return;
    }
    setErrors({});
    preview.mutate(
      {
        conversationId: card.conversationId,
        mcpServerId: connector.id,
        externalRef: ref,
        readTool: effectiveReadTool,
        idArg: effectiveIdArg,
      },
      {
        onSuccess: (res) => {
          setFound(res);
          setSelected(preselectedPointers(res.values, board.data?.board.fields ?? []));
        },
        onError: (err) => {
          setFound(null);
          const r = watchRefusal(err, { connector: name, recordId: ref, channel });
          if (r.at === "share") setShareRefused(true);
          else if (r.at === "recordId") setErrors({ recordId: r.text });
          else setErrors({ [r.at]: r.text });
        },
      },
    );
  };

  const toggle = (pointer: string, on: boolean) =>
    setSelected((prev) =>
      on ? [...prev.filter((p) => p !== pointer), pointer] : prev.filter((p) => p !== pointer),
    );

  const fields: WatchedField[] = fieldRows
    .filter((r) => selected.includes(r.pointer))
    .map((r) => ({ pointer: r.pointer, label: r.label.slice(0, 60) || r.pointer.slice(1, 61) }));

  const ready = edit ? true : found !== null && usable && !needsShare;
  const pending = create.isPending || update.isPending;

  const submit = () => {
    if (!ready || pending) return;
    const fieldErr = fieldsError(fields.length);
    const botErr = agent ? undefined : `Pick a bot that's a member of #${channel}`;
    if (fieldErr || botErr) {
      setErrors({ fields: fieldErr ?? undefined, bot: botErr });
      return;
    }
    setErrors({});
    const onError = (err: unknown) => {
      const r = watchRefusal(err, { connector: name, recordId: recordId.trim(), channel });
      if (r.at === "share") setShareRefused(true);
      else setErrors({ [r.at]: r.text });
    };
    if (edit && watch) {
      const body: UpdateWatchedRecordRequest = { expectedVersion: watch.version };
      const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
      if (
        !same(
          fields.map((f) => f.pointer),
          watch.fields.map((f) => f.pointer),
        )
      )
        body.fields = fields;
      if (interval !== watch.checkIntervalMinutes) body.checkIntervalMinutes = interval;
      if (effectiveAgentId !== watch.agent.id) body.agentId = effectiveAgentId;
      if ((writeTool || null) !== watch.writeTool) body.writeTool = writeTool || null;
      if ((noteTool || null) !== watch.noteTool) body.noteTool = noteTool || null;
      if (Object.keys(body).length === 1) {
        onDone();
        return;
      }
      update.mutate(
        { id: watch.id, body },
        {
          onSuccess: () => {
            toast.success("Watch updated.");
            onDone();
          },
          onError,
        },
      );
      return;
    }
    if (!connector) return;
    const ref = recordId.trim();
    create.mutate(
      {
        cardMessageId: card.messageId,
        mcpServerId: connector.id,
        externalRef: ref,
        readTool: effectiveReadTool,
        idArg: effectiveIdArg,
        ...(writeTool ? { writeTool } : {}),
        ...(noteTool ? { noteTool } : {}),
        fields,
        checkIntervalMinutes: interval,
        agentId: effectiveAgentId,
      },
      {
        onSuccess: () => {
          toast.success(`Watching ${ref}.`);
          onDone();
        },
        onError,
      },
    );
  };

  const noConnectors = !edit && opts !== undefined && opts.connectors.length === 0;
  const shareNoteId = id("share");
  const startDescribedBy = needsShare ? shareNoteId : undefined;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{edit ? "Edit watch" : "Watch an external record"}</DialogTitle>
        <DialogDescription>
          OCW checks the record and posts what changed in this card's thread. Nothing is overwritten.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="grid gap-4 max-sm:flex-1">
        {options.isPending ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Spinner className="size-3.5" /> Loading connectors…
          </div>
        ) : options.isError ? (
          <Notice tone="warning" role="alert">
            Couldn't load the connectors. {errorMessage(options.error)}
          </Notice>
        ) : noConnectors ? (
          <p className="text-muted-foreground text-sm" data-testid="watch-no-connectors">
            {NO_CONNECTORS}
          </p>
        ) : (
          <>
            <FormField id={id("connector")} label="Connector">
              {edit ? (
                <Input
                  id={id("connector")}
                  value={connector ? connectorLabel(connector) : name}
                  readOnly
                  aria-readonly
                  className={cn(TOUCH, "bg-muted/40 dark:bg-input/20")}
                  data-testid="watch-connector"
                />
              ) : (
                <Select
                  items={(opts?.connectors ?? []).map((c) => ({ value: c.id, label: connectorLabel(c) }))}
                  value={effectiveConnectorId || null}
                  onValueChange={(v) => {
                    if (!v || v === effectiveConnectorId) return;
                    setConnectorId(String(v));
                    setReadTool("");
                    setIdArg("");
                    setWriteTool("");
                    setNoteTool("");
                    setShareRefused(false);
                    resetFound();
                  }}
                >
                  <SelectTrigger
                    id={id("connector")}
                    data-testid="watch-connector"
                    placeholder="Pick a connector"
                    className={TOUCH}
                  />
                  <SelectContent>
                    {(opts?.connectors ?? []).map((c) => (
                      <SelectItem
                        key={c.id}
                        value={c.id}
                        disabled={c.authMode === "per_member" && c.connection !== "connected"}
                        data-testid="watch-connector-option"
                        className="max-md:min-h-11"
                      >
                        {connectorLabel(c)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
            {!edit ? <ConnectRows options={opts} /> : null}

            {connector && !edit && connector.authMode === "org_secret" ? (
              <Notice tone="neutral">
                Read with the workspace's {connector.name} access. Everyone in #{channel} sees the values.
              </Notice>
            ) : null}
            {connector && needsShare ? (
              <Notice tone="warning" id={shareNoteId} testId="watch-share-notice">
                <span className="block">
                  {shareNotice(connector.name, channel, opts?.channel.readers ?? 0)}
                </span>
                <Link
                  href={shareHref(card.conversationId, connector.id)}
                  onClick={() =>
                    rememberConnectReturn(
                      connector.id,
                      `/chat/${card.conversationId}?thread=${card.messageId}`,
                    )
                  }
                  className={cn(
                    buttonVariants({ variant: "outline", size: "sm" }),
                    TOUCH,
                    "mt-2 h-auto min-h-8 max-w-full whitespace-normal bg-background text-foreground",
                  )}
                  data-testid="watch-share-link"
                >
                  Allow {connector.name} in #{channel}
                  <ArrowUpRight aria-hidden />
                </Link>
              </Notice>
            ) : null}

            <FormField id={id("record")} label="Record ID" error={errors.recordId}>
              <div className="flex gap-2">
                <Input
                  id={id("record")}
                  value={recordId}
                  readOnly={edit}
                  aria-readonly={edit || undefined}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={!!errors.recordId}
                  aria-describedby={describedBy(id("record"), errors.recordId)}
                  onChange={(e) => {
                    setRecordId(e.target.value);
                    if (found) resetFound();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      find();
                    }
                  }}
                  className={cn("min-w-0 flex-1 font-mono", TOUCH, edit && "bg-muted/40 dark:bg-input/20")}
                  data-testid="watch-record-id"
                />
                {!edit ? (
                  <Button
                    type="button"
                    variant="outline"
                    className={cn("shrink-0", TOUCH)}
                    disabled={!connector || !usable || needsShare || preview.isPending}
                    onClick={find}
                    data-testid="watch-find"
                  >
                    {preview.isPending ? <Spinner className="size-3.5" /> : null}
                    Find
                  </Button>
                ) : null}
              </div>
            </FormField>

            {errors.form ? (
              <Notice tone="warning" role="alert" testId="watch-form-error">
                {errors.form}
              </Notice>
            ) : null}

            {found || (edit && fieldRows.length > 0) ? (
              <FieldsBox
                title={found?.label ? `Found: ${found.label}` : found ? `Found: ${recordId.trim()}` : null}
                rows={fieldRows}
                selected={selected}
                numberHints={found?.numberHints ?? []}
                error={errors.fields}
                errorId={id("fields-error")}
                onToggle={toggle}
                loading={edit && preview.isPending}
              />
            ) : null}

            <FormField id={id("interval")} label="Check every">
              <Select
                items={CHECK_INTERVALS.map((i) => ({ value: String(i.value), label: i.label }))}
                value={String(interval)}
                onValueChange={(v) => v && setIntervalMinutes(Number(v) as WatchedCheckInterval)}
              >
                <SelectTrigger id={id("interval")} data-testid="watch-interval" className={TOUCH} />
                <SelectContent>
                  {CHECK_INTERVALS.map((i) => (
                    <SelectItem key={i.value} value={String(i.value)} className="max-md:min-h-11">
                      {i.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField id={id("bot")} label="Report with" error={errors.bot}>
              <Select
                items={bots.map((b) => ({ value: b.id, label: b.displayName }))}
                value={effectiveAgentId || null}
                onValueChange={(v) => {
                  if (!v) return;
                  setAgentId(String(v));
                  setWriteTool("");
                  setNoteTool("");
                }}
              >
                <SelectTrigger
                  id={id("bot")}
                  data-testid="watch-bot"
                  placeholder={bots.length === 0 ? "No bots on this board" : "Pick a bot"}
                  aria-invalid={!!errors.bot}
                  aria-describedby={describedBy(id("bot"), errors.bot)}
                  className={TOUCH}
                />
                <SelectContent>
                  {bots.map((b) => (
                    <SelectItem
                      key={b.id}
                      value={b.id}
                      disabled={!botFor(b.id)}
                      data-testid="watch-bot-option"
                      className="max-md:min-h-11"
                    >
                      {botFor(b.id) ? b.displayName : `${b.displayName} · can't read ${name}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <div className="grid gap-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={advanced}
                aria-controls={id("advanced")}
                onClick={() => setAdvanced((a) => !a)}
                className={cn("-ml-2 justify-self-start", TOUCH)}
                data-testid="watch-advanced"
              >
                {advanced ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
                Advanced
              </Button>
              {advanced ? (
                <div
                  id={id("advanced")}
                  className="grid gap-4 sm:grid-cols-2"
                  data-testid="watch-advanced-section"
                >
                  <FormField id={id("read")} label="Read with">
                    <ToolSelect
                      id={id("read")}
                      testId="watch-read-tool"
                      value={effectiveReadTool}
                      tools={reads}
                      disabled={edit}
                      onChange={(v) => {
                        setReadTool(v);
                        setIdArg("");
                        if (found) resetFound();
                      }}
                    />
                  </FormField>
                  <FormField id={id("idarg")} label="Record ID argument">
                    <Input
                      id={id("idarg")}
                      value={effectiveIdArg}
                      readOnly={edit}
                      onChange={(e) => {
                        setIdArg(e.target.value.trim());
                        if (found) resetFound();
                      }}
                      className={cn("font-mono", TOUCH, edit && "bg-muted/40 dark:bg-input/20")}
                      data-testid="watch-id-arg"
                    />
                  </FormField>
                  <FormField id={id("write")} label="Update with (optional)">
                    <ToolSelect
                      id={id("write")}
                      testId="watch-write-tool"
                      value={writeTool}
                      tools={updates}
                      optional
                      onChange={setWriteTool}
                    />
                  </FormField>
                  <FormField id={id("note")} label="Add notes with (optional)">
                    <ToolSelect
                      id={id("note")}
                      testId="watch-note-tool"
                      value={noteTool}
                      tools={updates}
                      optional
                      onChange={setNoteTool}
                    />
                  </FormField>
                  <p className="text-[13px] text-muted-foreground sm:col-span-2">
                    Bots change the record only through the update tool, and only if it hasn't changed since
                    the last check.
                  </p>
                </div>
              ) : null}
            </div>
          </>
        )}
      </DialogBody>
      <DialogFooter className={cn(edit && "sm:justify-between")}>
        {edit && onStopWatching ? (
          <Button
            type="button"
            variant="ghost"
            className={cn("text-destructive hover:text-destructive sm:mr-auto", TOUCH)}
            onClick={() => {
              onDone();
              onStopWatching();
            }}
            data-testid="watch-stop"
          >
            <Trash2 aria-hidden />
            Stop watching…
          </Button>
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="outline" className={TOUCH} onClick={onDone}>
            Cancel
          </Button>
          <Button
            type="button"
            className={cn(TOUCH, "aria-disabled:cursor-not-allowed aria-disabled:opacity-50")}
            aria-disabled={!ready || pending || noConnectors || undefined}
            aria-describedby={startDescribedBy}
            data-disabled={!ready || noConnectors ? "" : undefined}
            onClick={submit}
            data-testid="watch-submit"
          >
            {pending ? <Spinner className="size-3.5" /> : null}
            {edit ? "Save changes" : "Start watching"}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

/** Per-member connectors the viewer has not connected: one "Connect in Settings" row each (UI-SPEC 7a). */
function ConnectRows({ options }: { options: WatchOptions | undefined }) {
  const off = (options?.connectors ?? []).filter(
    (c) => c.authMode === "per_member" && c.connection !== "connected",
  );
  if (off.length === 0) return null;
  return (
    <ul className="-mt-2 grid gap-1" data-testid="watch-connect-rows">
      {off.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted-foreground">
          <span>
            {c.name} {c.connection === "needs_reconnect" ? "needs a reconnect" : "isn't connected"}.
          </span>
          <Link
            href={connectHref(c.id)}
            className={cn(buttonVariants({ variant: "link", size: "sm" }), "h-auto p-0 max-md:min-h-11")}
            data-testid="watch-connect-link"
          >
            Connect in Settings
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ToolSelect({
  id,
  testId,
  value,
  tools,
  optional = false,
  disabled = false,
  onChange,
}: {
  id: string;
  testId: string;
  value: string;
  tools: ReadonlyArray<{ name: string; title: string | null }>;
  optional?: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const NONE = "__none__";
  const items = [
    ...(optional ? [{ value: NONE, label: "None" }] : []),
    ...tools.map((t) => ({ value: t.name, label: t.name })),
  ];
  return (
    <Select
      items={items}
      value={value || (optional ? NONE : null)}
      onValueChange={(v) => v !== null && onChange(v === NONE ? "" : String(v))}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        data-testid={testId}
        placeholder="Pick a tool"
        className={cn("font-mono", TOUCH)}
      />
      <SelectContent>
        {items.map((i) => (
          <SelectItem
            key={i.value}
            value={i.value}
            className={cn("max-md:min-h-11", i.value !== NONE && "font-mono")}
          >
            {i.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The found record's fields: native checkboxes with label and current value (plain text, truncated with a Tooltip). */
export function FieldsBox({
  title,
  rows,
  selected,
  numberHints,
  error,
  errorId,
  onToggle,
  loading = false,
}: {
  title: string | null;
  rows: ReadonlyArray<{ pointer: string; label: string; value: string | null }>;
  selected: readonly string[];
  numberHints: readonly string[];
  error?: string;
  errorId: string;
  onToggle: (pointer: string, on: boolean) => void;
  loading?: boolean;
}) {
  return (
    <div className="grid gap-2 rounded-lg bg-muted/40 p-3 dark:bg-white/[0.03]" data-testid="watch-found">
      {title ? <p className="break-words font-semibold text-sm">{title}</p> : null}
      <fieldset className="grid gap-1" aria-describedby={error ? errorId : undefined}>
        <legend className="mb-1 font-medium text-muted-foreground text-xs">Fields to watch</legend>
        {loading ? (
          <p className="flex items-center gap-2 text-muted-foreground text-xs">
            <Spinner className="size-3" /> Reading the record…
          </p>
        ) : null}
        {rows.map((r) => {
          const checked = selected.includes(r.pointer);
          const hint = numberHints.includes(r.pointer);
          return (
            <label
              key={r.pointer}
              className="grid cursor-pointer grid-cols-[auto_minmax(0,9rem)_minmax(0,1fr)] items-center gap-x-2.5 rounded-md px-1 py-1 hover:bg-accent/60 max-md:min-h-11"
              data-testid="watch-field"
              data-pointer={r.pointer}
            >
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={checked}
                onChange={(e) => onToggle(r.pointer, e.target.checked)}
              />
              <span className="truncate text-sm">{r.label}</span>
              <span className="min-w-0">
                <TruncatedValue value={r.value} />
                {hint ? (
                  <span className="block text-muted-foreground text-xs" data-testid="watch-number-hint">
                    {NUMBER_HINT}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </fieldset>
      {error ? (
        <p id={errorId} role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function TruncatedValue({ value }: { value: string | null }) {
  const text = value ?? "(empty)";
  return (
    <Tooltip content={text} disabled={text.length <= 32} className="max-w-72 whitespace-normal break-words">
      <span className={cn("block truncate text-muted-foreground text-sm", value === null && "italic")}>
        {text}
      </span>
    </Tooltip>
  );
}

function Notice({
  tone,
  children,
  id,
  role = "note",
  testId,
}: {
  tone: "warning" | "neutral";
  children: ReactNode;
  id?: string;
  role?: "note" | "alert";
  testId?: string;
}) {
  const Icon = tone === "warning" ? TriangleAlert : Info;
  return (
    <div
      id={id}
      role={role}
      data-testid={testId}
      className={cn(
        "flex gap-2 rounded-lg border px-3 py-2 text-xs",
        tone === "warning"
          ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200"
          : "bg-muted/40 text-muted-foreground",
      )}
    >
      <Icon aria-hidden className="mt-px size-3.5 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
