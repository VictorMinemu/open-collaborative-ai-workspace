"use client";

import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { FullPageLoader } from "@/components/common/full-page-loader";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { AppShell } from "@/components/shell/app-shell";
import { isApiError } from "@/lib/api";
import { signedInMe, useMe, useSetupStatus } from "@/lib/queries";

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
    // The query travels too (07.12, D-13): a signed-out owner opening a server's `?pair=` link gets it back after
    // sign-in. The effect runs only in the browser; `safeNext` on the login page keeps it a same-app path.
    else router.replace(`/login?next=${encodeURIComponent(`${pathname}${window.location.search}`)}`);
  }, [unauthenticated, setup.data, pathname, router]);

  // A 401 wins over the cached `/me`: the session ended, so the shell is not rendered while sign-in opens.
  const member = signedInMe(me);
  if (member) return <AppShell me={member}>{children}</AppShell>;

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
