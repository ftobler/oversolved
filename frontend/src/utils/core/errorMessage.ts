// One place to turn a caught `unknown` into text a banner can show.
//
// Every failure the UI reports now comes from the same two sources -- an
// IndexedDB request that rejected, or the WASM kernel throwing -- and both carry
// a real `message`. So the message IS the user-facing text; the caller's
// `fallback` covers the cases where it is not (a non-Error thrown value, an
// empty message), where a bare "" or "[object Object]" in a red banner would tell
// the user nothing at all.
//
// Deliberately NOT `String(e)`, which prefixes "Error: " onto every message and
// reads as a stack trace leaking into the UI.
export function errorMessage(e: unknown, fallback: string): string {
  const text = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  return text.trim() || fallback
}
