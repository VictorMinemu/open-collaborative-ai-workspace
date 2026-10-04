"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export interface Typer {
  kind: "user" | "agent";
  id: string;
  name: string;
  /** null = typing at channel level. */
  threadRootId: string | null;
  expiresAt: number;
}

const USER_TTL = 5_000;
const AGENT_TTL = 12_000;

/** Live "X is typing" state for one conversation, fed by ephemeral `user.typing` / `agent.typing`. */
export function useTypers() {
  const [typers, setTypers] = useState<Typer[]>([]);

  useEffect(() => {
    if (typers.length === 0) return;
    const t = setInterval(() => {
      const now = Date.now();
      setTypers((prev) => {
        const next = prev.filter((x) => x.expiresAt > now);
        return next.length === prev.length ? prev : next;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [typers.length]);

  const touch = useCallback((t: Omit<Typer, "expiresAt">) => {
    const expiresAt = Date.now() + (t.kind === "agent" ? AGENT_TTL : USER_TTL);
    setTypers((prev) => [...prev.filter((x) => !(x.kind === t.kind && x.id === t.id)), { ...t, expiresAt }]);
  }, []);

  /** A message from this author arrived: they are done typing. */
  const clear = useCallback((kind: string, id: string | null) => {
    setTypers((prev) => {
      const next = prev.filter((x) => !(x.kind === kind && x.id === id));
      return next.length === prev.length ? prev : next;
    });
  }, []);

  return { typers, touch, clear };
}

export function typingLabel(typers: Typer[], inThreadHint = false): string | null {
  if (typers.length === 0) return null;
  const names = typers.map((t) => t.name);
  const verb = inThreadHint && typers.every((t) => t.threadRootId) ? "replying in a thread" : "typing";
  if (names.length === 1) return `${names[0]} is ${verb}`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are ${verb}`;
  return "Several people are typing";
}

export function TypingDots({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-[3px]", className)} aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="chat-typing-dot size-[5px] rounded-full bg-current"
          style={{ animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </span>
  );
}

/** Fixed-height line under the message list so the layout never jumps. */
export function TypingIndicator({ typers, inThreadHint }: { typers: Typer[]; inThreadHint?: boolean }) {
  const label = typingLabel(typers, inThreadHint);
  return (
    <div
      data-testid="typing-indicator"
      aria-live="polite"
      className="flex h-6 shrink-0 items-center gap-2 px-4 text-muted-foreground text-xs sm:px-5"
    >
      {label ? (
        <>
          <TypingDots className={typers.some((t) => t.kind === "agent") ? "text-primary" : ""} />
          <span className="truncate">
            <span className="font-medium text-foreground/80">{label}</span>…
          </span>
        </>
      ) : null}
    </div>
  );
}
