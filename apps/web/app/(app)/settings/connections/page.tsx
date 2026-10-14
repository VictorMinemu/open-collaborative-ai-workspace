import type { Metadata } from "next";
import { ConnectionsPage } from "@/components/connectors/connections-page";

export const metadata: Metadata = { title: "Connections" };

/**
 * Settings › Connections (07.4-13, UI-SPEC § 2): the member's own accounts on per-member connectors, the return from a
 * provider's sign-in, and the conversations they allowed an account in. Connecting is part of the Bots module
 * (`connector.connect`, ADR-0024); disconnecting is not, so with Bots off the page keeps the withdrawal view while the
 * member still has something to withdraw (07.4-14, WINDOWS #196).
 */
export default function SettingsConnectionsPage() {
  return <ConnectionsPage />;
}
