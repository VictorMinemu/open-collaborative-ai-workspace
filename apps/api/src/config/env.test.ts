import { describe, expect, it } from "vitest";
import { EnvSchema } from "./env";

describe("OCW_SIGNIN_RATE_LIMIT_PER_MINUTE", () => {
  const shape =
    EnvSchema.shape ??
    (EnvSchema as unknown as { _def: { schema: { shape: Record<string, never> } } })._def.schema.shape;
  const field = (shape as Record<string, { safeParse: (v: unknown) => { success: boolean; data?: unknown } }>)
    .OCW_SIGNIN_RATE_LIMIT_PER_MINUTE;

  it("defaults to 30 sign-ins per minute (production brake)", () => {
    expect(field.safeParse(undefined)).toMatchObject({ success: true, data: 30 });
  });

  it("accepts a raised value for test harnesses and rejects nonsense", () => {
    expect(field.safeParse("600")).toMatchObject({ success: true, data: 600 });
    expect(field.safeParse("0").success).toBe(false);
    expect(field.safeParse("abc").success).toBe(false);
  });
});
