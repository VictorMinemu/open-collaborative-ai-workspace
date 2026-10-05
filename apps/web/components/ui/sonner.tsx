"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useMediaQuery } from "@/hooks/use-media-query";

export function Toaster(props: ToasterProps) {
  const { resolvedTheme } = useTheme();
  // On a phone the bottom of the screen is the composer: toasts drop from the top instead of covering it.
  const phone = useMediaQuery("(max-width: 639px)", false);
  return (
    <Sonner
      theme={(resolvedTheme as ToasterProps["theme"]) ?? "system"}
      position={phone ? "top-center" : "bottom-right"}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast: "!rounded-lg !border-border !bg-popover !text-popover-foreground !shadow-lg",
          description: "!text-muted-foreground",
        },
      }}
      {...props}
    />
  );
}
