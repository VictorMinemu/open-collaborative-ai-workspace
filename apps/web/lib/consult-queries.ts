"use client";

import { AgentChainCancelResponse } from "@ocw/contracts";
import { type UseMutationOptions, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, isApiError } from "./api";

/**
 * Stop for an agent-to-agent chain (07.7-10; A2A-03, D-04, P-14). The API decides who may stop it (the chain's human or a
 * moderator of the channel, 07.7-06): the button is only a hint. No optimistic update: the chip changes when the server
 * announces the hop's new status (`message.updated` with `consult.status = "cancelled"`), for every reader at once.
 */

/** `POST /api/v1/agent-chains/:id/cancel` → `{chainId, status}`; idempotent on the server. */
export function cancelAgentChain(chainId: string): Promise<AgentChainCancelResponse> {
  return api.post(`/api/v1/agent-chains/${chainId}/cancel`, { schema: AgentChainCancelResponse });
}

type Tone = "success" | "info" | "error";

function toastNotify(tone: Tone, text: string): void {
  if (tone === "success") toast.success(text);
  else if (tone === "info") toast.message(text);
  else toast.error(text);
}

/**
 * Stop's mutation with its toast in the mutation's own options (07.7-11 gate). The chip turns Stopped, and the Stop
 * button unmounts, as soon as the server announces the hop, which can be before the HTTP answer; callbacks passed to
 * `mutate()` are dropped once their observer unmounts, these are not. `source` is the asking bot as the chip names it.
 */
export function cancelChainMutation(
  source: string,
  notify: (tone: Tone, text: string) => void = toastNotify,
  mutationFn: (chainId: string) => Promise<AgentChainCancelResponse> = cancelAgentChain,
): UseMutationOptions<AgentChainCancelResponse, unknown, string> {
  return {
    mutationFn,
    onSuccess: (r) => {
      // CR-C-05: the API's actual status (a chain that finished meanwhile is not "Stopped").
      const result = stopResultToast(r, source);
      notify(result.tone, result.text);
    },
    onError: (err) => notify("error", stopErrorMessage(err)),
  };
}

export function useCancelAgentChain(source: string) {
  return useMutation(cancelChainMutation(source));
}

/** The success toast; `source` is the asking bot as the chip names it (`@archie`, or `a bot`). */
export function stopSuccessMessage(source: string): string {
  const who = source.charAt(0).toUpperCase() + source.slice(1);
  return `Stopped. ${who} won't get more answers for this request.`;
}

/**
 * The toast after Stop, from the status the API answered (CR-C-05). The route is idempotent: a chain that finished while
 * the button was showing answers `completed`, so "Stopped" is said only when the chain is `cancelled`.
 */
export function stopResultToast(
  r: AgentChainCancelResponse,
  source: string,
): { tone: "success" | "info" | "error"; text: string } {
  if (r.status === "cancelled") return { tone: "success", text: stopSuccessMessage(source) };
  if (r.status === "completed") return { tone: "info", text: "This request had already finished." };
  return { tone: "error", text: "This request couldn't be stopped. Try again." };
}

/** 403 `not_chain_owner` and 404 `chain_not_found` in people's words; anything else is the API's own message. */
export function stopErrorMessage(err: unknown): string {
  if (isApiError(err, 403)) return "Only the person who asked or a channel moderator can stop this.";
  if (isApiError(err, 404)) return "This request is no longer available.";
  return errorMessage(err);
}
