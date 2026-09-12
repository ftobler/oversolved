// A workspace-level revision counter, so a UI can re-read after any write. The
// store emits on open, close and every mutating verb; phase E's dirty/subscription
// surfaces consume it the way the feature row consumes fileRegistry events.
let revision = 0
const listeners = new Set<() => void>()

export function workspaceStoreRevision(): number {
  return revision
}

export function bumpWorkspaceStoreRevision(): void {
  revision++
  for (const listener of listeners) listener()
}

export function subscribeWorkspaceStore(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
