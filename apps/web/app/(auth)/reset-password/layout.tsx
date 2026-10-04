import type { Metadata } from "next";
import type { ReactNode } from "react";

/** The reset link carries a one-time secret in its query: never send it as a Referer, never index it. */
export const metadata: Metadata = {
  title: "Reset password",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function ResetPasswordLayout({ children }: { children: ReactNode }) {
  return children;
}
