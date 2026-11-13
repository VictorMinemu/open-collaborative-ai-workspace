"use client";

import { BotTaskStopResponse } from "@ocw/contracts";
import { type UseMutationOptions, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "./api";

/**
 * Stop for a bot's long task (07.17.1.1.2-10; D-05, PD-12). The API decides who may stop it (the person it runs for, a
 * moderator of the channel or the bot's manager, 07.17.1.1.2-08): the card's button is only a hint from `viewerCan`.
 * No optimistic update: the card turns Stopped when the server announces it (`message.updated` with the task's new
 * status), for every reader at once.
 */

/** `POST /api/v1/bot-tasks/:id/stop` → `{ ok, status }`; idempotent on the server. */
export function stopBotTask(taskId: string): Promise<BotTaskStopResponse> {
  return api.post(`/api/v1/bot-tasks/${encodeURIComponent(taskId)}/stop`, { schema: BotTaskStopResponse });
}

type Tone = "success" | "info" | "error";

function toastNotify(tone: Tone, text: string): void {
  if (tone === "success") toast.success(text);
  else if (tone === "info") toast.message(text);
  else toast.error(text);
}

/** The toast after Stop, from the status the API answered (a task that ended meanwhile is not "stopped"). */
export function stopTaskToast(r: BotTaskStopResponse): { tone: Tone; text: string } {
  if (r.status === "stopped") return { tone: "success", text: "Task stopped." };
  if (r.status === "running" || r.status === "waiting") {
    return { tone: "error", text: "This task couldn't be stopped. Try again." };
  }
  return { tone: "info", text: "This task had already finished." };
}

/**
 * Stop's mutation with its toast in the mutation's own options (the chain Stop's 07.7-11 rule): the Stop button
 * unmounts as soon as the server announces the stopped task, which can be before the HTTP answer; callbacks passed to
 * `mutate()` are dropped once their observer unmounts, these are not. An error shows the server's own message.
 */
export function stopTaskMutation(
  taskId: string,
  notify: (tone: Tone, text: string) => void = toastNotify,
  stop: (taskId: string) => Promise<BotTaskStopResponse> = stopBotTask,
): UseMutationOptions<BotTaskStopResponse, unknown, void> {
  return {
    mutationKey: ["bot-tasks", taskId, "stop"],
    mutationFn: () => stop(taskId),
    onSuccess: (r) => {
      const said = stopTaskToast(r);
      notify(said.tone, said.text);
    },
    onError: (err) => notify("error", errorMessage(err)),
  };
}

export function useStopTask(taskId: string) {
  return useMutation(stopTaskMutation(taskId));
}
