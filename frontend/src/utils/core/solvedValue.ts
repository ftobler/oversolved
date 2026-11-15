// A number a feature's last solve reported, for an editor row that shows a
// solved value instead of an authored one. The solve result crosses the worker
// boundary untyped, so the read is a guarded key lookup rather than a cast: a
// missing key, a non-object result or a non-finite value all read as "not
// reported", and the row stays hidden.

export function solvedNumber(solved: unknown, key: string): number | null {
  if (typeof solved !== 'object' || solved === null) return null
  const value = Reflect.get(solved, key)
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
