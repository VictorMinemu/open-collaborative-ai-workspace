"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { type ReactNode, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfigProvider, type RuntimeConfig } from "@/lib/config";
import { RealtimeProvider } from "@/lib/realtime";

export function Providers({ config, children }: { config: RuntimeConfig; children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { refetchOnWindowFocus: false, staleTime: 15_000, retryDelay: 600 },
          mutations: { retry: false },
        },
      }),
  );

  return (
    <ConfigProvider config={config}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <QueryClientProvider client={queryClient}>
          <RealtimeProvider>
            <TooltipProvider delay={400}>{children}</TooltipProvider>
          </RealtimeProvider>
          <Toaster />
        </QueryClientProvider>
      </ThemeProvider>
    </ConfigProvider>
  );
}
