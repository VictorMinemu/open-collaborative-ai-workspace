"use client";

import {
  type ReviewSandboxPackageRequest,
  SandboxPackageName,
  type SandboxPackageSource,
  SandboxPackageVersion,
} from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { PackagePlus } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
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
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, isApiError } from "@/lib/api";
import { fetchPackageReview } from "@/lib/sandbox-packages-queries";
import { cn } from "@/lib/utils";
import { SOURCE_LABEL } from "./package-review-sheet";

/**
 * Add a sandbox package (07.8-23; D-03, D-11, P-12, UI-SPEC §4.4): the source, the exact package name and the exact
 * version to pin. Review asks the API for a live review of that release (sandboxd resolves its whole tree); the review
 * sheet opens with it, and the registry's answers (no such package, unreachable) stay in this form. Nothing is approved
 * here.
 */

const SOURCES: readonly SandboxPackageSource[] = ["npm", "pypi", "debian", "clawhub"];

const PLACEHOLDER: Record<SandboxPackageSource, string> = {
  npm: "left-pad",
  pypi: "pandas",
  debian: "ffmpeg",
  clawhub: "pdf-tools",
};

export type PackageDraft = ReviewSandboxPackageRequest;

/** The first problem with a draft, or null when it can be reviewed. */
export function draftError(d: PackageDraft): { field: "name" | "version"; message: string } | null {
  const name = d.name.trim();
  const version = d.version.trim();
  if (!name) return { field: "name", message: "Enter a package name" };
  if (!SandboxPackageName.safeParse(name).success) {
    return { field: "name", message: "Use the package's exact name, like pandas or @scope/name" };
  }
  if (!version) return { field: "version", message: "Enter the exact version, like 2.3.1" };
  if (!SandboxPackageVersion.safeParse(version).success) {
    return { field: "version", message: "Use one exact version, not a range or “latest”" };
  }
  return null;
}

/** What the form says when the review could not be made. Unknown codes fall back to the API's message. */
export function reviewErrorMessage(err: unknown, d: PackageDraft): string {
  if (isApiError(err, 404)) return `No package called “${d.name}” on ${SOURCE_LABEL[d.source]}.`;
  if (isApiError(err, 503) || (isApiError(err) && err.isNetwork)) {
    return `Couldn't reach ${SOURCE_LABEL[d.source]}. Try again.`;
  }
  return errorMessage(err);
}

export function AddPackageDialog({
  open,
  onOpenChange,
  onReviewed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The review is in the cache: open the sheet on it. */
  onReviewed: (req: ReviewSandboxPackageRequest) => void;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="add-package-dialog"
        className="sm:max-w-lg max-sm:top-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:rounded-none"
        initialFocus={nameRef}
      >
        <AddPackageForm nameRef={nameRef} onCancel={() => onOpenChange(false)} onReviewed={onReviewed} />
      </DialogContent>
    </Dialog>
  );
}

function AddPackageForm({
  nameRef,
  onCancel,
  onReviewed,
}: {
  nameRef: React.RefObject<HTMLInputElement | null>;
  onCancel: () => void;
  onReviewed: (req: ReviewSandboxPackageRequest) => void;
}) {
  const qc = useQueryClient();
  const id = useId();
  const [draft, setDraft] = useState<PackageDraft>({ source: "npm", name: "", version: "" });
  const [error, setError] = useState<{ field: "name" | "version" | "form"; message: string } | null>(null);
  const [pending, setPending] = useState(false);

  const edit = (patch: Partial<PackageDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setError(null);
  };

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (pending) return;
    const invalid = draftError(draft);
    if (invalid) {
      setError(invalid);
      return;
    }
    const req = { source: draft.source, name: draft.name.trim(), version: draft.version.trim() };
    setPending(true);
    try {
      await fetchPackageReview(qc, req);
      onReviewed(req);
    } catch (err) {
      setError({ field: isApiError(err, 404) ? "name" : "form", message: reviewErrorMessage(err, req) });
    } finally {
      setPending(false);
    }
  }

  const errorId = `${id}-error`;
  const describe = (field: "name" | "version") =>
    [`${id}-${field}-hint`, error?.field === field ? errorId : null].filter(Boolean).join(" ");

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
      <DialogHeader>
        <DialogTitle>Add a sandbox package</DialogTitle>
        <DialogDescription>
          Pinned to one exact version. It installs inside each bot's sandbox, never in the bot runtime.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="grid flex-1 content-start gap-5">
        <fieldset className="min-w-0">
          <legend className="mb-2 font-medium text-sm">Source</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {SOURCES.map((s) => {
              const selected = draft.source === s;
              return (
                <label
                  key={s}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-xl border bg-card px-3 py-2.5 shadow-xs transition-colors",
                    selected && "border-primary/50 bg-brand-soft/40 ring-1 ring-primary/30",
                  )}
                >
                  <input
                    type="radio"
                    name={`${id}-source`}
                    value={s}
                    checked={selected}
                    onChange={() => edit({ source: s })}
                    data-testid={`package-source-${s}`}
                    className="size-4 shrink-0 accent-primary"
                  />
                  <span className="min-w-0 font-medium text-sm leading-tight">{SOURCE_LABEL[s]}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="grid gap-1.5">
          <label htmlFor={`${id}-name`} className="font-medium text-sm">
            Package
          </label>
          <Input
            ref={nameRef}
            id={`${id}-name`}
            value={draft.name}
            onChange={(e) => edit({ name: e.target.value })}
            placeholder={PLACEHOLDER[draft.source]}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={error?.field === "name" ? true : undefined}
            aria-describedby={describe("name")}
            className="font-mono text-[13px] max-md:h-11"
            data-testid="package-name"
          />
          <span id={`${id}-name-hint`} className="text-muted-foreground text-xs">
            The exact name on {SOURCE_LABEL[draft.source]}.
          </span>
        </div>

        <div className="grid gap-1.5">
          <label htmlFor={`${id}-version`} className="font-medium text-sm">
            Version
          </label>
          <Input
            id={`${id}-version`}
            value={draft.version}
            onChange={(e) => edit({ version: e.target.value })}
            placeholder="2.3.1"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={error?.field === "version" ? true : undefined}
            aria-describedby={describe("version")}
            className="font-mono text-[13px] max-md:h-11 sm:w-56"
            data-testid="package-version"
          />
          <span id={`${id}-version-hint`} className="text-muted-foreground text-xs">
            One exact version. Ranges and “latest” aren't accepted.
          </span>
        </div>

        {error ? (
          <p
            id={errorId}
            role="alert"
            className="rounded-lg bg-destructive/8 px-3 py-2 text-[13px] text-destructive"
            data-testid="add-package-error"
          >
            {error.message}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} className="max-md:h-11">
          Cancel
        </Button>
        <Button type="submit" disabled={pending} className="max-md:h-11" data-testid="package-review">
          {pending ? <Spinner /> : <PackagePlus />}
          Review
        </Button>
      </DialogFooter>
    </form>
  );
}
