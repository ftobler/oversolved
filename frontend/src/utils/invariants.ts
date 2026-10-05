// PURE LOGIC -- no Three.js, no React refs, no stores.
// The 3-tier guard helper shared by the kernel, the picking core, the stores and
// the UI: throw in test, warn in dev, silent in production.
//
// It lives in a neutral utils leaf rather than `stores/stateInvariants.ts` so
// the CAD kernel does not import the stores layer (and, through it, the tool
// registry and the picking key helpers) just for a dev/test harness. The stores
// module re-exports these so existing callers keep their import site.

export const devOnly = import.meta.env?.DEV ?? false
export const testMode = import.meta.env?.MODE === 'test'

/**
 * Emit a fail-loud signal when an invariant is violated.
 * Throws in test mode, warns in dev, silent in production.
 */
export function failLoud(message: string): void {
  if (testMode) {
    throw new Error(message)
  }
  if (devOnly) {
    console.warn(message)
  }
}
