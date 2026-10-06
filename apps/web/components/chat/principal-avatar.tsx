import { Bot } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage, toneFor, UserAvatar } from "@/components/ui/avatar";
import { cn, initials } from "@/lib/utils";

const isUrl = (s: string) => /^(https?:)?\/\//.test(s) || s.startsWith("/") || s.startsWith("data:");

/**
 * Avatar for any principal. Humans: round initials/photo. Agents: rounded square with their emoji, image or a
 * bot glyph, on the brand tint — bots are recognisable at a glance in every list.
 */
export function PrincipalAvatar({
  kind,
  name,
  avatarUrl,
  seed,
  compact,
  className,
}: {
  kind: "user" | "agent" | "system";
  name: string;
  avatarUrl?: string | null | undefined;
  seed?: string | null | undefined;
  /** Tiny avatars (stacks): one initial, smaller type. */
  compact?: boolean;
  className?: string;
}) {
  if (kind !== "agent") {
    // People's avatars are an https photo or an emoji (ORG-06).
    if (avatarUrl && !isUrl(avatarUrl))
      return <UserAvatar name={name} src={avatarUrl} className={className} />;
    return (
      <Avatar className={className}>
        {avatarUrl ? <AvatarImage src={avatarUrl} alt="" referrerPolicy="no-referrer" /> : null}
        <AvatarFallback className={cn(toneFor(seed ?? name), compact && "font-semibold text-[10px]")}>
          {initials(name, compact ? 1 : 2)}
        </AvatarFallback>
      </Avatar>
    );
  }
  return (
    <span
      data-slot="bot-avatar"
      className={cn(
        "relative inline-flex size-8 shrink-0 select-none items-center justify-center overflow-hidden rounded-[30%] bg-brand-soft text-brand-soft-foreground ring-1 ring-primary/15",
        className,
      )}
    >
      {avatarUrl && isUrl(avatarUrl) ? (
        // biome-ignore lint/performance/noImgElement: arbitrary user-provided bot avatars (no Next image domains)
        <img src={avatarUrl} alt="" referrerPolicy="no-referrer" className="size-full object-cover" />
      ) : avatarUrl ? (
        <span className={cn("leading-none", compact ? "text-[11px]" : "text-[1.05em]")} aria-hidden>
          {avatarUrl}
        </span>
      ) : (
        <Bot className="size-[55%]" strokeWidth={1.9} aria-hidden />
      )}
    </span>
  );
}

/**
 * A group DM's stacked avatars (the first two members, the second offset), for DM rows and headers. Each takes 60%
 * of the box so the back avatar's initial stays clear of the front one (at 70% the front covered it).
 */
export function GroupAvatars({
  members,
  className,
  large,
}: {
  members: ReadonlyArray<{ kind: "user" | "agent"; id: string; name: string; avatarUrl: string | null }>;
  className?: string;
  /** Header and intro sizes: larger initials. */
  large?: boolean;
}) {
  const [a, b] = members;
  const text = large ? "text-[10px] sm:text-xs" : "text-[8px]";
  return (
    <span className={cn("relative inline-flex size-5 shrink-0", className)} aria-hidden>
      {a ? (
        <PrincipalAvatar
          kind={a.kind}
          name={a.name}
          avatarUrl={a.avatarUrl}
          seed={a.id}
          compact
          className={cn("absolute top-0 left-0 size-[60%] ring-1 ring-background", text)}
        />
      ) : null}
      {b ? (
        <PrincipalAvatar
          kind={b.kind}
          name={b.name}
          avatarUrl={b.avatarUrl}
          seed={b.id}
          compact
          className={cn("absolute right-0 bottom-0 size-[60%] ring-2 ring-background", text)}
        />
      ) : null}
    </span>
  );
}

export function BotBadge({ className }: { className?: string }) {
  return (
    <span
      data-testid="bot-badge"
      className={cn(
        "inline-flex h-4 items-center rounded-[4px] bg-brand-soft px-1 font-semibold text-[9.5px] text-brand-soft-foreground uppercase tracking-wider",
        className,
      )}
    >
      Bot
    </span>
  );
}
