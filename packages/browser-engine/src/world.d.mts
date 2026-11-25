// Types of world.mjs (07.13 D-04, PD-02): the agent's isolated world and the CDP calls that keep it registered.

/** The CDP session the world needs: Playwright's CDPSession, or a fake in tests. */
export interface CdpSender {
  send(method: string, params?: object): Promise<unknown>;
}

export interface CreateWorldOptions {
  attempts?: number;
  retryMs?: number;
}

export const WORLD: "__ocw_agent_world";
export const WORLD_ATTEMPTS: number;

export function worldScript(active: boolean): string;
/** Resolves with the world's execution context id in the main frame's current document. */
export function createWorld(cdp: CdpSender, active: boolean, options?: CreateWorldOptions): Promise<number>;
/** Resolves with the new registration's identifier. */
export function replaceWorldScript(
  cdp: CdpSender,
  oldId: string | null | undefined,
  active: boolean,
): Promise<string>;
