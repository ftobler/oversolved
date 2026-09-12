// A rendered thumbnail, keyed by (workspace, entry). A preview is derived from
// the document, so it lives outside the workspace tree and outside the workspace
// database: its own IndexedDB database, in the same neighbourhood as the bundle
// cache. A wipe is a harmless miss, never a lost document (I5, A9).
export interface PreviewRecord {
  workspace: string
  entry: string
  image: string  // base64 PNG, no data: prefix (matches the old save body)
  updatedAt: number
}

export interface PreviewKey {
  workspace: string
  entry: string
}

export interface PreviewStore {
  get(workspace: string, entry: string): Promise<string | undefined>
  getMany(keys: PreviewKey[]): Promise<Map<string, string>>
  put(workspace: string, entry: string, image: string): Promise<void>
  remove(workspace: string, entry: string): Promise<void>
  clearWorkspace(workspace: string): Promise<void>  // purge path
}

// The key getMany's map uses and callers look up. Both parts are uuids, so a
// colon never appears inside one and the join is unambiguous.
export function previewKey(workspace: string, entry: string): string {
  return `${workspace}:${entry}`
}
