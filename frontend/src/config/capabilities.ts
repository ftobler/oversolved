// Deployment capabilities, derived from a runtime flag. Kept dependency-free
// (no store / JSZip imports) so any component can read `hasBackend` without
// dragging the persistence layer into its import graph.
//
// The mode is injected at runtime by /runtime-config.js -- a tiny, non-bundled
// file loaded before the app bundle evaluates -- NOT baked in at build time.
// That keeps ONE application bundle for every deployment; only that one-line
// file differs:
//   window.__OVERSOLVED_BACKEND__ = 'http'    -> Flask PDM backend present (default)
//                                 = 'static'   -> zero-backend, IndexedDB-only build

export type Backend = 'http' | 'static'

declare global {
  interface Window {
    __OVERSOLVED_BACKEND__?: string
  }
}

// Anything other than the explicit 'static' opt-in stays on HTTP, so a missing
// or malformed runtime-config (unit tests, a deploy that forgot the file) falls
// back to the server-backed app -- the safe default.
export function resolveBackend(raw?: string): Backend {
  return raw === 'static' ? 'static' : 'http'
}

export const backend: Backend = resolveBackend(
  typeof window === 'undefined' ? undefined : window.__OVERSOLVED_BACKEND__,
)

// Is there a server to talk to? Server-only features (auth, sharing, admin,
// rebuild stats) are absent -- not broken -- when this is false. Callers gate
// on it rather than hitting error paths.
export const hasBackend = backend === 'http'
