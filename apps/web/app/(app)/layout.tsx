"use client";

import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { FullPageLoader } from "@/components/common/full-page-loader";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { AppShell } from "@/components/shell/app-shell";
import { isApiError } from "@/lib/api";
import { useMe, useSetupStatus } from "@/lib/queries";

/**
 * Client-side auth guard for every workspace page: `/me` → shell; 401 → /setup (fresh server) or /login.
 * The API enforces auth on every request; this only decides what to render.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const me = useMe();
  const unauthenticated = isApiError(me.error, 401);
  const setup = useSetupStatus(unauthenticated);

  useEffect(() => {
    if (!unauthenticated || !setup.data) return;
    if (!setup.data.setupComplete) router.replace("/setup");
    else router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [unauthenticated, setup.data, pathname, router]);

  if (me.data) return <AppShell me={me.data}>{children}</AppShell>;

  const failed = (me.isError && !unauthenticated) || setup.isError;
  if (failed) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <ServerUnreachable
          onRetry={() => (setup.isError ? setup.refetch() : me.refetch())}
          retrying={me.isFetching || setup.isFetching}
        />
      </div>
    );
  }

  return <FullPageLoader />;
}
