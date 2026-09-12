// A revision counter the feature row subscribes to. A just-created import must
// re-render the row that shows its name and size, and a plain component only
// learns of an async store write through this.
let revision = 0
const listeners = new Set<() => void>()

export function fileRegistryRevision(): number {
  return revision
}

export function bumpFileRegistryRevision(): void {
  revision++
  for (const listener of listeners) listener()
}

export function subscribeFileRegistry(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
