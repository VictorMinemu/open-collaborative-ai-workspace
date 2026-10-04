import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Label } from "./label";

/**
 * Label + control + hint/error. The control must use `id={id}` and
 * `aria-describedby={describedBy(id, error, hint)}` / `aria-invalid={!!error}`.
 */
export function FormField({
  id,
  label,
  hint,
  error,
  action,
  className,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("grid gap-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {action}
      </div>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[13px] text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function describedBy(id: string, error?: string, hint?: ReactNode): string | undefined {
  if (error) return `${id}-error`;
  if (hint) return `${id}-hint`;
  return undefined;
}
