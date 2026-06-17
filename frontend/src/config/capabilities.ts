// Deployment capabilities, derived from the build flag. Kept dependency-free
// (no store / JSZip imports) so any component can read `hasBackend` without
// dragging the persistence layer into its import graph.
//
// VITE_OVERSOLVED_BACKEND = 'http'   -> Flask PDM backend present (default)
//                         = 'static' -> zero-backend, IndexedDB-only build

export type Backend = 'http' | 'static'

// Anything other than the explicit 'static' opt-in stays on HTTP, so existing
// builds are untouched.
export function resolveBackend(raw?: string): Backend {
  return raw === 'static' ? 'static' : 'http'
}

export const backend: Backend = resolveBackend(import.meta.env.VITE_OVERSOLVED_BACKEND)

// Is there a server to talk to? Server-only features (auth, sharing, admin,
// rebuild stats) are absent -- not broken -- when this is false. Callers gate
// on it rather than hitting error paths.
export const hasBackend = backend === 'http'
