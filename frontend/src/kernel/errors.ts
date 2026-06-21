// Normalize an unknown thrown value into a human-readable message. Errors keep
// their message; anything else is stringified.
export function extractErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
