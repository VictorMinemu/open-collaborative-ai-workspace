import { LogoMark } from "@/components/brand/logo";

export function FullPageLoader({ label = "Loading workspace" }: { label?: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4" aria-busy>
      <LogoMark className="size-10 animate-pulse rounded-xl" />
      <p className="text-muted-foreground text-sm">{label}…</p>
    </div>
  );
}
