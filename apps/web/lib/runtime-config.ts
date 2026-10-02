/** Shared by the server root layout and client code (no "use client" here on purpose). */
export interface RuntimeConfig {
  apiUrl: string;
  wsUrl: string;
}

export function toRuntimeConfig(apiUrl: string): RuntimeConfig {
  const base = apiUrl.replace(/\/+$/, "");
  return { apiUrl: base, wsUrl: `${base.replace(/^http/, "ws")}/ws` };
}
