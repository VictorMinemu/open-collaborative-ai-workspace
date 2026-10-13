import type { SensitiveFinding, SensitiveFindingKind } from "@ocw/contracts";
import { ScanSearch, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The findings of a memory proposal (07.2-13, MEM-05, UI-SPEC "Findings", "Status and notices"): one row per warn or
 * block finding (kind, severity chip, count, masked samples, lines), the extended-scan state as a polite amber notice
 * (`role="status"`, T-07.2-13-05), and "No sensitive data found" when there is nothing. Samples are the server's masked
 * strings, rendered as text; a raw value never reaches this component (T-07.2-13-04). A row is a button when the review
 * can jump to it in the diff.
 */

export const FINDING_LABEL: Record<SensitiveFindingKind, string> = {
  secret: "Secret",
  iban: "IBAN",
  payment_card: "Card number",
  es_nif: "NIF",
  es_nie: "NIE",
  email: "Email",
  phone: "Phone",
  person: "Person name",
  location: "Place",
  ip_address: "IP address",
  extended_scan_unavailable: "Extended scan unavailable",
  extended_scan_partial: "Extended scan incomplete",
};

const SCAN_KINDS: readonly SensitiveFindingKind[] = ["extended_scan_unavailable", "extended_scan_partial"];

/** Findings shown as rows (the extended-scan markers are a notice, not a finding). */
export const listedFindings = (findings: readonly SensitiveFinding[]) =>
  findings.filter((f) => !SCAN_KINDS.includes(f.kind));

const SEVERITY: Record<SensitiveFinding["severity"], { label: string; tone: string }> = {
  block: {
    label: "Blocked",
    tone: "border-transparent bg-red-100 text-red-800 dark:bg-red-400/15 dark:text-red-300",
  },
  warn: {
    label: "Check",
    tone: "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
  },
  info: { label: "Info", tone: "border-border text-muted-foreground" },
};

export const SCAN_UNAVAILABLE = "Extended scan unavailable — review the text yourself";
export const SCAN_PARTIAL = "Extended scan incomplete — review the text yourself";

/** "Line 3", "Lines 4, 7". */
export const linesText = (lines: readonly number[]) =>
  lines.length === 1 ? `Line ${lines[0]}` : `Lines ${lines.join(", ")}`;

/** The amber notice for an extended scan that did not answer (or answered in part). */
export function ScanNotice({ findings }: { findings: readonly SensitiveFinding[] }) {
  const unavailable = findings.some((f) => f.kind === "extended_scan_unavailable");
  const partial = !unavailable && findings.some((f) => f.kind === "extended_scan_partial");
  if (!unavailable && !partial) return null;
  return (
    <p
      role="status"
      data-testid="extended-scan-notice"
      className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 text-sm leading-5 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200"
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>{unavailable ? SCAN_UNAVAILABLE : SCAN_PARTIAL}</span>
    </p>
  );
}

function FindingRow({ finding, onSelect }: { finding: SensitiveFinding; onSelect?: () => void }) {
  const severity = SEVERITY[finding.severity];
  const label = FINDING_LABEL[finding.kind];
  const body = (
    <>
      <span className="min-w-0 font-semibold text-sm">{label}</span>
      <span
        className={cn(
          "inline-flex h-5 w-fit items-center rounded-md border px-1.5 font-medium text-[11px] leading-none",
          severity.tone,
        )}
      >
        {severity.label}
      </span>
      <span className="text-muted-foreground text-xs tabular-nums">{finding.count} found</span>
      <span className="min-w-0 truncate font-mono text-xs">{finding.samples.join("  ")}</span>
      <span className="text-muted-foreground text-xs sm:justify-self-end">
        {finding.lines.length > 0 ? linesText(finding.lines) : null}
      </span>
    </>
  );
  const grid =
    "grid w-full grid-cols-[minmax(5.5rem,auto)_auto_1fr] items-center gap-x-3 gap-y-1 px-3 py-2 text-left sm:grid-cols-[7rem_auto_4.5rem_minmax(0,1fr)_auto] max-sm:[&>*:nth-child(4)]:col-span-2 max-sm:[&>*:nth-child(5)]:justify-self-end";
  return (
    <li data-testid="finding" data-kind={finding.kind} data-severity={finding.severity}>
      {onSelect ? (
        <button
          type="button"
          onClick={onSelect}
          className={cn(
            grid,
            "min-h-11 rounded-md outline-none hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/40 lg:min-h-10",
          )}
        >
          {body}
        </button>
      ) : (
        <div className={grid}>{body}</div>
      )}
    </li>
  );
}

export function FindingsList({
  findings,
  onSelect,
}: {
  findings: readonly SensitiveFinding[];
  /** Jumps the diff to a finding (its first line, its spans). */
  onSelect?: (finding: SensitiveFinding) => void;
}) {
  const rows = listedFindings(findings);
  return (
    <div className="grid gap-2" data-testid="findings">
      <ScanNotice findings={findings} />
      {rows.length > 0 ? (
        <ul aria-label="Sensitive data" className="-mx-3 grid">
          {rows.map((f) => (
            <FindingRow
              key={`${f.kind}:${f.source}`}
              finding={f}
              onSelect={onSelect ? () => onSelect(f) : undefined}
            />
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-2 text-muted-foreground text-sm" data-testid="findings-none">
          <ScanSearch aria-hidden className="size-4" />
          No sensitive data found
        </p>
      )}
    </div>
  );
}
