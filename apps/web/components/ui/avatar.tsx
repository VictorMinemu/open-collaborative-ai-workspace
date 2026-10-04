import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar";
import type { ComponentProps } from "react";
import { cn, initials } from "@/lib/utils";

export function Avatar({ className, ...props }: ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn("relative flex size-8 shrink-0 select-none overflow-hidden rounded-full", className)}
      {...props}
    />
  );
}

export function AvatarImage({ className, ...props }: ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image className={cn("aspect-square size-full object-cover", className)} {...props} />
  );
}

export function AvatarFallback({ className, ...props }: ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      className={cn(
        "flex size-full items-center justify-center bg-muted font-medium text-muted-foreground text-xs",
        className,
      )}
      {...props}
    />
  );
}

/** Deterministic, pleasant hue per name so people are recognisable at a glance. */
const TONES = [
  "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300",
];

export function toneFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return TONES[h % TONES.length] ?? TONES[0]!;
}

/** Avatar values are an image URL or an emoji (ORG-06); anything that is not a URL renders as text. */
export function isImageSrc(src: string): boolean {
  return /^(https?:)?\/\//.test(src) || src.startsWith("/") || src.startsWith("data:");
}

/**
 * A person: their photo (fetched without a referrer, so third-party hosts cannot track who views it), their
 * emoji avatar, or coloured initials.
 */
export function UserAvatar({
  name,
  src,
  seed,
  className,
}: {
  name: string;
  src?: string | null | undefined;
  seed?: string | null | undefined;
  className?: string;
}) {
  if (src && !isImageSrc(src)) {
    return (
      <Avatar
        className={cn("@container items-center justify-center bg-muted", className)}
        data-avatar="emoji"
      >
        <span aria-hidden className="text-[60cqw] leading-none">
          {src}
        </span>
      </Avatar>
    );
  }
  return (
    <Avatar className={className}>
      {src ? <AvatarImage src={src} alt="" referrerPolicy="no-referrer" /> : null}
      <AvatarFallback className={toneFor(seed ?? name)}>{initials(name)}</AvatarFallback>
    </Avatar>
  );
}
