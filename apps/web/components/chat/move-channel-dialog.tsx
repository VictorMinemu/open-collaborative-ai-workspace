"use client";

import type { ChannelSummary } from "@ocw/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { useUpdateChannel } from "@/lib/chat-queries";
import { ChannelUnitSelect, usePlaceableUnits } from "./create-channel-dialog";

/**
 * "Move to…" (CHAT-02): the channel owner or an admin regroups a channel under another department, team or project,
 * or back under the organization. The unit's permission rules apply from then on; the API decides and audits.
 */
export function MoveChannelDialog({
  channel,
  open,
  onOpenChange,
}: {
  channel: ChannelSummary;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const update = useUpdateChannel();
  const placeable = usePlaceableUnits();
  const current = channel.unit?.id ?? null;
  const [unitId, setUnitId] = useState<string | null>(current);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (open) {
      setUnitId(current);
      setError(undefined);
    }
  }, [open, current]);

  // The current unit stays selectable even when the caller could not place a channel there today.
  const units =
    channel.unit && !placeable.some((u) => u.id === channel.unit?.id)
      ? [
          ...placeable,
          {
            id: channel.unit.id,
            label: (channel.unit.pathNames ?? [channel.unit.name]).join(" › "),
            depth: channel.unit.path.length - 1,
          },
        ]
      : placeable;
  const target = unitId === null ? null : (units.find((u) => u.id === unitId)?.label ?? null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (unitId === current) {
      onOpenChange(false);
      return;
    }
    update.mutate(
      { id: channel.id, body: { unitId } },
      {
        onSuccess: () => {
          onOpenChange(false);
          toast.success(`#${channel.name} moved`, {
            description: target
              ? `It now belongs to ${target}.`
              : "It now belongs to the whole organization.",
          });
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="move-channel-dialog">
        <DialogHeader>
          <DialogTitle>Move #{channel.name}</DialogTitle>
          <DialogDescription>
            Choose where the channel is grouped in everyone's sidebar. The rules of that department, team or
            project apply to it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-5" noValidate>
          <FormField id="move-channel-unit" label="Belongs to" error={error}>
            <ChannelUnitSelect
              id="move-channel-unit"
              value={unitId}
              onChange={(v) => {
                setUnitId(v);
                setError(undefined);
              }}
              units={units}
            />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={update.isPending || unitId === current}
              data-testid="move-channel-submit"
            >
              {update.isPending ? <Spinner /> : null}
              Move channel
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
