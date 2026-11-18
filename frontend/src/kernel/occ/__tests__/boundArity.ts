/**
 * The declared parameter count of an embind-bound method, static or free
 * function, for the surface probes.
 *
 * Function `.length` stopped carrying it with `occt-8.0.1-r3`: the build defers
 * each invoker to its first call behind a zero-parameter stub, so every member
 * reads `.length` 0. Embind still stamps `argCount` on the public symbol when it
 * registers it (parameters only, not the return value or `this`), the same
 * count the real invoker checks on every call, so it is what a probe reads.
 * An overloaded name carries an `overloadTable` instead; the build suffixes its
 * overloads (`_1`, `_2`), so a missing `argCount` is reported, not guessed.
 *
 * A method whose argument types never resolved keeps embind's placeholder,
 * which throws when called but carries the same `argCount`; it is the only
 * method symbol stamped with `className` (the resolved invoker replaces it
 * without one), so it is reported as unbound instead of passing on its count.
 * The static placeholder has no such mark and is not told apart here.
 */
export function boundArity(member: unknown): number | string {
  const symbol = member as { argCount?: unknown; className?: unknown }
  if (symbol.className !== undefined) return `unbound (types of ${String(symbol.className)} never resolved)`
  const count = symbol.argCount
  return typeof count === 'number' ? count : `unreadable (argCount ${String(count)})`
}
