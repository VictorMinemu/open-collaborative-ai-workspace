import type { ReactNode } from "react";
import { Logo, PRODUCT_NAME } from "@/components/brand/logo";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-background">
      {/* Subtle backdrop: dotted grid fading out + accent glow. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,var(--color-border)_1px,transparent_0)] bg-size-[22px_22px] [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,black,transparent)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-48 left-1/2 h-[28rem] w-[56rem] -translate-x-1/2 rounded-full bg-primary/15 blur-3xl dark:bg-primary/10"
      />

      <header className="relative z-10 flex items-center justify-between px-5 py-5 sm:px-8">
        <Logo />
      </header>

      <main className="relative z-10 flex flex-1 items-start justify-center px-4 pt-4 pb-16 sm:items-center sm:pt-0">
        <div className="w-full max-w-[26rem]">{children}</div>
      </main>

      <footer className="relative z-10 px-6 pb-6 text-center text-muted-foreground text-xs">
        {PRODUCT_NAME} · open source, self-hosted
      </footer>
    </div>
  );
}
