import { z } from "zod";

export const HealthStatus = z.enum(["ok", "error"]);
export const HealthResponse = z.object({
  status: HealthStatus,
  version: z.string(),
  checks: z.object({ db: HealthStatus, redis: HealthStatus }),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
