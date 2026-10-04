/** Anything with a Zod-style `safeParse`. */
interface SafeParser<T> {
  safeParse(
    data: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

/** Validate with a contracts schema; returns parsed data or the first error per top-level field. */
export function validate<T, K extends string>(
  schema: SafeParser<T>,
  values: Record<K, unknown>,
): { data: T; errors: null } | { data: null; errors: FieldErrors<K> } {
  const result = schema.safeParse(values);
  if (result.success) return { data: result.data, errors: null };
  const errors: FieldErrors<K> = {};
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? "") as K;
    if (key && !errors[key]) errors[key] = friendly(issue.message);
  }
  return { data: null, errors };
}

function friendly(message: string): string {
  if (/^Invalid email/i.test(message)) return "Enter a valid email address";
  const tooSmall = /^Too small: expected string to have >=(\d+) characters?/.exec(message);
  if (tooSmall) return tooSmall[1] === "1" ? "Required" : `Use at least ${tooSmall[1]} characters`;
  return message;
}
