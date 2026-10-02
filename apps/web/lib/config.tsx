"use client";

import { createContext, type ReactNode, useContext } from "react";

/**
 * Runtime (not build-time) configuration. The root layout reads `OCW_PUBLIC_API_URL` on the server per
 * request and hands it down here, so one Docker image works against any API URL.
 */
export interface RuntimeConfig {
  apiUrl: string;
  wsUrl: string;
}

let current: RuntimeConfig = toRuntimeConfig("http://localhost:4000");

export function toRuntimeConfig(apiUrl: string): RuntimeConfig {
  const base = apiUrl.replace(/\/+$/, "");
  return { apiUrl: base, wsUrl: `${base.replace(/^http/, "ws")}/ws` };
}

/** Module-level accessor for non-React code (the fetch helper). */
export function getRuntimeConfig(): RuntimeConfig {
  return current;
}

const ConfigContext = createContext<RuntimeConfig>(current);

export function ConfigProvider({ config, children }: { config: RuntimeConfig; children: ReactNode }) {
  // Set synchronously during render so queries fired by children (in effects) see the right base URL.
  current = config;
  return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>;
}

export function useRuntimeConfig(): RuntimeConfig {
  return useContext(ConfigContext);
}
