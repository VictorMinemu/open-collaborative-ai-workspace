"use client";

import { useId } from "react";
import { Input } from "@/components/ui/input";
import { type InboundErrors, type InboundValue, liveValueText } from "@/lib/automation-trigger-queries";
import { cn } from "@/lib/utils";

const FIELDS = [
  { key: "titlePointer", label: "Title", placeholder: "/order/name", testid: "mapping-title" },
  { key: "bodyPointer", label: "Body", placeholder: "/order/note", testid: "mapping-body" },
  { key: "threadKeyPointer", label: "Same item", placeholder: "/order/id", testid: "mapping-thread-key" },
] as const;

/**
 * Map the payload (07.6-18, R4, UI-SPEC Surface 3): three optional RFC 6901 pointers (title, body, the key that keeps
 * follow-ups in one thread), each with the value it names in the last delivery, as plain text in curly quotes. Before
 * any delivery (or for a viewer who may not read the payload) there is nothing to preview. No template language.
 */
export function InboundMapping({
  value,
  onChange,
  errors,
  payload,
  delivered = false,
  disabled,
}: {
  value: InboundValue;
  onChange: (next: InboundValue) => void;
  errors: InboundErrors;
  /** The last delivery's parsed body (the owner's), or null when there is none to read. */
  payload: unknown | null;
  /** Deliveries exist but their payload is not the viewer's to read (a manager) or was cleared: no preview. */
  delivered?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const has = payload !== null && payload !== undefined;
  return (
    <fieldset className="grid gap-2" data-testid="inbound-mapping">
      <legend className="mb-1 font-semibold text-sm">Map the payload (optional)</legend>
      {FIELDS.map((f) => {
        const err = errors[f.key];
        const live = has ? liveValueText(payload, value[f.key]) : null;
        const inputId = `${id}-${f.key}`;
        return (
          <div
            key={f.key}
            className="grid gap-x-3 gap-y-1 md:grid-cols-[5.5rem_minmax(0,16rem)_minmax(0,1fr)] md:items-center"
          >
            <label htmlFor={inputId} className="text-[13px] text-muted-foreground md:text-right">
              {f.label}
            </label>
            <Input
              id={inputId}
              data-testid={f.testid}
              value={value[f.key]}
              placeholder={f.placeholder}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={!!err}
              aria-describedby={err ? `${inputId}-error` : `${id}-hint`}
              onChange={(e) => onChange({ ...value, [f.key]: e.target.value })}
              className="font-mono text-[13px] max-md:h-11"
            />
            {live !== null ? (
              <span
                data-testid={`${f.testid}-value`}
                className={cn(
                  "min-w-0 truncate text-muted-foreground text-xs",
                  live === "no value" && "italic",
                )}
                title={live}
              >
                <span aria-hidden>→ </span>
                {live}
              </span>
            ) : (
              <span className="max-md:hidden" />
            )}
            {err ? (
              <p
                id={`${inputId}-error`}
                role="alert"
                className="text-[13px] text-destructive md:col-start-2 md:col-end-4"
              >
                {err}
              </p>
            ) : null}
          </div>
        );
      })}
      <p id={`${id}-hint`} className="text-muted-foreground text-xs">
        {has
          ? "Values come from the last delivery. Leave empty to use the whole payload."
          : delivered
            ? "Leave empty to use the whole payload."
            : "Send a test event to preview values."}
      </p>
    </fieldset>
  );
}
