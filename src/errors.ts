// What a caught value says, without asserting what was thrown.

export const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

// The errno code (ENOENT, EEXIST, ...) of a failed system call, if any.
export function errorCode(cause: unknown): string | undefined {
  if (!(cause instanceof Error) || !("code" in cause) || cause.code === undefined) return undefined;

  return String(cause.code);
}
