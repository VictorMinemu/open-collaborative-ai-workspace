"use client";

import type { DefaultNotifyLevel, NotificationPrefs, UpdateNotificationPrefsRequest } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, BellRing, Moon, Send } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/api";
import { useDesktop } from "@/lib/desktop";
import { dndActive, updateNotificationPrefs, useNotificationPrefs } from "@/lib/notification-queries";
import {
  DND_PRESETS,
  dndPresetUntil,
  formatDndUntil,
  notificationPermission,
  type OsPermission,
  requestNotificationPermission,
  showOsNotification,
} from "@/lib/os-notifications";
import { cn } from "@/lib/utils";

const LEVELS: Array<{ value: DefaultNotifyLevel; label: string }> = [
  { value: "all", label: "All new messages" },
  { value: "mentions", label: "Mentions only" },
  { value: "nothing", label: "Nothing" },
];

const PERMISSION_TEXT: Record<OsPermission, string> = {
  granted: "Allowed. Pop-ups show while the app is open.",
  default: "Not enabled yet in this browser.",
  denied: "Blocked in this browser. Allow notifications for this site in the browser's site settings.",
  unsupported: "This browser can't show notifications. The inbox and badges still work.",
};

/** The browser's permission, re-read after a click and whenever the page comes back into view. */
function usePermission(): [OsPermission, () => void] {
  const [p, setP] = useState<OsPermission>("unsupported");
  const refresh = () => setP(notificationPermission());
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh only reads the browser
  useEffect(() => {
    refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, []);
  return [p, refresh];
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3">
      <div>
        <h2 className="font-semibold text-[15px] tracking-tight">{title}</h2>
        <p className="mt-0.5 text-muted-foreground text-sm">{description}</p>
      </div>
      <div className="grid divide-y rounded-xl border bg-card shadow-xs">{children}</div>
    </section>
  );
}

function Row({
  id,
  label,
  hint,
  children,
  testId,
  inline = false,
}: {
  id?: string;
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  testId?: string;
  /** Keep the control beside the label on phones too (switches). */
  inline?: boolean;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "flex gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:p-5",
        inline ? "flex-row items-center justify-between" : "flex-col",
      )}
    >
      <div className="min-w-0">
        {id ? (
          <Label htmlFor={id} className="font-medium text-sm">
            {label}
          </Label>
        ) : (
          <div className="font-medium text-sm">{label}</div>
        )}
        {hint ? <div className="mt-0.5 text-muted-foreground text-xs">{hint}</div> : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * Settings › Notifications (CHAT-10, D-02): pop-ups in this browser (permission asked only from the "Enable
 * notifications" click), the desktop app and web toggles, what channels notify by default and do not disturb. Every
 * change is saved at once and reaches the member's other tabs and devices (`notification_prefs.updated`).
 */
export function NotificationSettings() {
  const qc = useQueryClient();
  const prefs = useNotificationPrefs();
  const desktop = useDesktop();
  const [permission, refreshPermission] = usePermission();
  const [custom, setCustom] = useState("");

  const save = (patch: UpdateNotificationPrefsRequest) =>
    void updateNotificationPrefs(qc, patch).catch((err) =>
      toast.error("Could not save your notification settings", { description: errorMessage(err) }),
    );

  if (!prefs.data) {
    return (
      <div className="grid gap-4" aria-busy>
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }
  const p: NotificationPrefs = prefs.data;
  const paused = dndActive(p);
  const here = desktop ? "the desktop app" : "this browser";

  return (
    <div className="grid gap-10" data-testid="notification-settings">
      <Section
        title="Pop-up notifications"
        description="Mentions, direct messages and replies pop up while OCW is open in a browser tab or the desktop app."
      >
        <Row
          label={desktop ? "This desktop app" : "This browser"}
          hint={<span data-testid="notification-permission">{PERMISSION_TEXT[permission]}</span>}
          testId="notification-permission-row"
        >
          {permission === "default" ? (
            <Button
              size="sm"
              data-testid="enable-notifications"
              onClick={async () => {
                // The only place permission is requested: this click (a user gesture), never on load.
                const result = await requestNotificationPermission();
                refreshPermission();
                if (result === "granted") toast.success("Notifications enabled");
              }}
            >
              <BellRing /> Enable notifications
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            data-testid="test-notification"
            disabled={permission !== "granted"}
            onClick={() =>
              showOsNotification({
                id: `test-${Date.now()}`,
                title: "OCW",
                body: "Notifications are working.",
                onClick: () => {},
              })
            }
          >
            <Send /> Send a test notification
          </Button>
        </Row>
        <Row
          id="desktop-enabled"
          inline
          label="Desktop app notifications"
          hint={desktop ? "Pop-ups from this app." : "Pop-ups from the OCW desktop app on your computers."}
        >
          <Switch
            id="desktop-enabled"
            data-testid="desktop-enabled"
            checked={p.desktopEnabled}
            onCheckedChange={(v: boolean) => save({ desktopEnabled: v })}
          />
        </Row>
        <Row
          id="web-enabled"
          inline
          label="Web notifications"
          hint={
            desktop
              ? "Pop-ups from OCW in a browser tab."
              : "Pop-ups from OCW in a browser tab, like this one."
          }
        >
          <Switch
            id="web-enabled"
            data-testid="web-enabled"
            checked={p.webEnabled}
            onCheckedChange={(v: boolean) => save({ webEnabled: v })}
          />
        </Row>
      </Section>

      <Section
        title="Channels"
        description="What pops up from channels you haven't set yourself. Direct messages always notify unless you change them from their bell menu."
      >
        <Row id="default-level" label="Notify me about">
          <Select
            items={LEVELS}
            value={p.defaultLevel}
            onValueChange={(v) =>
              v && v !== p.defaultLevel && save({ defaultLevel: v as DefaultNotifyLevel })
            }
          >
            <SelectTrigger
              id="default-level"
              data-testid="default-level"
              aria-label="Notify me about"
              className="w-full sm:w-52"
            />
            <SelectContent>
              {LEVELS.map((l) => (
                <SelectItem key={l.value} value={l.value} data-testid={`default-level-${l.value}`}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      </Section>

      <Section
        title="Do not disturb"
        description={`Pause pop-ups for a while. Everything still reaches your inbox and badges, and ${here} stays quiet.`}
      >
        <Row
          inline
          label={paused ? "Notifications are paused" : "Notifications are on"}
          hint={
            <span data-testid="dnd-status">
              {paused && p.dndUntil ? `Paused until ${formatDndUntil(p.dndUntil)}` : "Not paused"}
            </span>
          }
        >
          <span
            aria-hidden
            className={cn(
              "flex size-8 items-center justify-center rounded-full",
              paused ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
            )}
          >
            {paused ? <Moon className="size-4" /> : <BellRing className="size-4" />}
          </span>
          {paused ? (
            <Button
              size="sm"
              variant="outline"
              data-testid="dnd-off"
              onClick={() => save({ dndUntil: null })}
            >
              <Bell /> Resume now
            </Button>
          ) : null}
        </Row>
        <div className="grid gap-3 p-4 sm:p-5">
          <div className="font-medium text-sm">Pause for</div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            {DND_PRESETS.map((d) => (
              <Button
                key={d.id}
                size="sm"
                variant="outline"
                data-testid={`dnd-${d.id}`}
                className={cn(d.id === "tomorrow" && "col-span-2")}
                onClick={() => save({ dndUntil: dndPresetUntil(d.id) })}
              >
                {d.label}
              </Button>
            ))}
          </div>
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-center"
            onSubmit={(e) => {
              e.preventDefault();
              const at = new Date(custom);
              if (!custom || Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) {
                toast.error("Pick a time in the future");
                return;
              }
              save({ dndUntil: at.toISOString() });
            }}
          >
            <Label htmlFor="dnd-custom" className="text-muted-foreground text-sm sm:mr-1">
              Until
            </Label>
            <Input
              id="dnd-custom"
              type="datetime-local"
              data-testid="dnd-custom"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              className="sm:w-56"
            />
            <Button type="submit" size="sm" variant="secondary" data-testid="dnd-custom-set">
              Pause
            </Button>
          </form>
        </div>
      </Section>
    </div>
  );
}
