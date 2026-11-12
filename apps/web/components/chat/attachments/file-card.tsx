"use client";

import type { Attachment } from "@ocw/contracts";
import {
  Download,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileMusic,
  FileSpreadsheet,
  FileText,
  FileVideoCamera,
  type LucideIcon,
  Presentation,
} from "lucide-react";
import { useRuntimeConfig } from "@/lib/config";
import { cn } from "@/lib/utils";
import { type FileKind, fileKind, formatBytes, middleEllipsis } from "./files";

const ICONS: Record<FileKind, { icon: LucideIcon; tone: string }> = {
  pdf: { icon: FileText, tone: "bg-red-500/10 text-red-600 dark:bg-red-400/15 dark:text-red-300" },
  doc: { icon: FileText, tone: "bg-blue-500/10 text-blue-600 dark:bg-blue-400/15 dark:text-blue-300" },
  sheet: {
    icon: FileSpreadsheet,
    tone: "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
  },
  slides: {
    icon: Presentation,
    tone: "bg-orange-500/10 text-orange-600 dark:bg-orange-400/15 dark:text-orange-300",
  },
  archive: {
    icon: FileArchive,
    tone: "bg-amber-500/10 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
  },
  code: {
    icon: FileCode,
    tone: "bg-violet-500/10 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300",
  },
  text: { icon: FileText, tone: "bg-slate-500/10 text-slate-600 dark:bg-slate-400/15 dark:text-slate-300" },
  image: { icon: FileImage, tone: "bg-sky-500/10 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300" },
  audio: { icon: FileMusic, tone: "bg-pink-500/10 text-pink-600 dark:bg-pink-400/15 dark:text-pink-300" },
  video: {
    icon: FileVideoCamera,
    tone: "bg-indigo-500/10 text-indigo-600 dark:bg-indigo-400/15 dark:text-indigo-300",
  },
  other: { icon: File, tone: "bg-muted text-muted-foreground" },
};

/** A tinted file-type icon (PDF red, sheets green, archives amber…). */
export function FileIcon({
  contentType,
  name,
  className,
}: {
  contentType: string;
  name: string;
  className?: string;
}) {
  const { icon: Icon, tone } = ICONS[fileKind(contentType, name)];
  return (
    <span className={cn("flex shrink-0 items-center justify-center rounded-md", tone, className)} aria-hidden>
      <Icon className="size-[18px]" />
    </span>
  );
}

/** "PDF", "ZIP", "PNG": the extension when there is one, else the type family. */
function typeLabel(a: Attachment): string {
  const dot = a.filename.lastIndexOf(".");
  const ext = dot > 0 ? a.filename.slice(dot + 1) : "";
  if (ext && ext.length <= 5) return ext.toUpperCase();
  const kind = fileKind(a.contentType, a.filename);
  return kind === "other" ? "File" : kind[0]!.toUpperCase() + kind.slice(1);
}

/**
 * A non-image attachment under a message (CHAT-12): icon, name, type and size, and a download that goes through the
 * API (it re-checks access, audits and redirects to a short-lived `attachment`-disposition URL). The file's content
 * is never embedded in the page (T-04-12-02).
 */
export function FileCard({ attachment }: { attachment: Attachment }) {
  const { apiUrl } = useRuntimeConfig();
  return (
    <div
      data-testid="file-card"
      data-attachment-id={attachment.id}
      className="flex w-full max-w-[22rem] items-center gap-3 rounded-lg border bg-background py-2 pr-2 pl-2.5 shadow-xs dark:bg-input/20"
    >
      <FileIcon contentType={attachment.contentType} name={attachment.filename} className="size-10" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-[13.5px] leading-5" title={attachment.filename}>
          {middleEllipsis(attachment.filename, 36)}
        </p>
        <p className="text-[12px] text-muted-foreground tabular-nums leading-4">
          {typeLabel(attachment)} · {formatBytes(attachment.size)}
        </p>
      </div>
      <a
        href={`${apiUrl}${attachment.downloadUrl}`}
        data-testid="file-download"
        aria-label={`Download ${attachment.filename}`}
        title="Download"
        rel="noopener"
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground max-md:size-11 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        <Download className="size-4" />
      </a>
    </div>
  );
}
