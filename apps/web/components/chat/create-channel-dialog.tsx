"use client";

import { CreateChannelRequest } from "@ocw/contracts";
import { Globe, Hash, Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, isApiError } from "@/lib/api";
import { useCreateChannel } from "@/lib/chat-queries";
import { useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";

/** "Product Launch!" → "product-launch" (as you type, like Slack). */
export function toChannelName(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80);
}

export function CreateChannelDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const me = useMe({ enabled: false });
  const create = useCreateChannel();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [error, setError] = useState<string | undefined>();

  const reset = () => {
    setName("");
    setTopic("");
    setVisibility("public");
    setError(undefined);
    create.reset();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = CreateChannelRequest.safeParse({ name: name.replace(/^-+|-+$/g, ""), topic, visibility });
    if (!parsed.success) {
      setError(name ? "Use lowercase letters, numbers, - and _" : "Give the channel a name");
      return;
    }
    create.mutate(parsed.data, {
      onSuccess: (channel) => {
        onOpenChange(false);
        reset();
        router.push(`/chat/${channel.id}`);
      },
      onError: (err) =>
        setError(isApiError(err, 409) ? `#${parsed.data.name} already exists` : errorMessage(err)),
    });
  };

  const org = me.data?.organization.name ?? "your workspace";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent data-testid="create-channel-dialog">
        <DialogHeader>
          <DialogTitle>Create a channel</DialogTitle>
          <DialogDescription>
            Channels are where your team and your bots work together around a topic.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-5" noValidate>
          <FormField id="channel-name" label="Name" error={error}>
            <div className="relative">
              <Hash className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="channel-name"
                autoFocus
                autoComplete="off"
                placeholder="e.g. product-launch"
                value={name}
                maxLength={80}
                onChange={(e) => {
                  setName(toChannelName(e.target.value));
                  setError(undefined);
                }}
                aria-invalid={!!error}
                aria-describedby={describedBy("channel-name", error)}
                className="pl-8"
              />
            </div>
          </FormField>
          <FormField
            id="channel-topic"
            label={
              <>
                Topic <span className="font-normal text-muted-foreground">(optional)</span>
              </>
            }
          >
            <Input
              id="channel-topic"
              autoComplete="off"
              placeholder="What is this channel about?"
              value={topic}
              maxLength={250}
              onChange={(e) => setTopic(e.target.value)}
            />
          </FormField>
          <fieldset className="grid gap-2">
            <legend className="mb-2 font-medium text-sm">Visibility</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  { v: "public", icon: Globe, title: "Public", body: `Anyone in ${org} can find and join` },
                  { v: "private", icon: Lock, title: "Private", body: "Only invited people and bots" },
                ] as const
              ).map((o) => (
                <label
                  key={o.v}
                  className={cn(
                    "flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors has-focus-visible:ring-[3px] has-focus-visible:ring-ring/40",
                    visibility === o.v ? "border-primary/60 bg-primary/5" : "hover:bg-accent/50",
                  )}
                >
                  <input
                    type="radio"
                    name="visibility"
                    value={o.v}
                    checked={visibility === o.v}
                    onChange={() => setVisibility(o.v)}
                    className="sr-only"
                    data-testid={`visibility-${o.v}`}
                  />
                  <o.icon
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      visibility === o.v ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <span className="grid gap-0.5">
                    <span className="font-medium text-sm">{o.title}</span>
                    <span className="text-muted-foreground text-xs leading-snug">{o.body}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !name} data-testid="create-channel-submit">
              {create.isPending ? <Spinner /> : null}
              Create channel
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
