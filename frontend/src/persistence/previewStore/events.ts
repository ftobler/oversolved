// A revision counter the tile subscribes to, following fileRegistry/events.ts.
// A save writes the preview store asynchronously, so a plain component only
// learns of it through this and re-renders the tile.
let revision = 0
const listeners = new Set<() => void>()

export function previewRevision(): number {
  return revision
}

export function bumpPreviewRevision(): void {
  revision++
  for (const listener of listeners) listener()
}

export function subscribePreview(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
