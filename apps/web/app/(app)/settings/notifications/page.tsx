import { Bell } from "lucide-react";
import type { Metadata } from "next";
import { NotificationSettings } from "@/components/settings/notification-settings";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = { title: "Notifications" };

export default function SettingsNotificationsPage() {
  return (
    <>
      <PageHeader title="Notifications" icon={<Bell />} description="Pop-ups, defaults and do not disturb" />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-3xl gap-10 px-4 py-6 sm:px-6 sm:py-8">
          <NotificationSettings />
        </div>
      </div>
    </>
  );
}
