import type { FileBytes } from '@/kernel/worker/solverProtocol'
import type { AssemblyExportPartSpec } from '@/kernel/worker/solverProtocol'
import type { FileRegistry } from './types'

// The session-first resolution seam: prefers the open workspace's entry, falls
// back to C1's flat staging registry. A structural type so callers pass the
// live WorkspaceSession without importing it here.
interface FileResolver {
  resolveFile(fileId: string): Promise<Uint8Array | undefined>
}

// Every import_step file id a spec references, deduped. A missing id is simply
// absent from the resolved map; the kernel handler owns the loud error.
export function fileIdsInSpec(spec: Record<string, unknown>): string[] {
  const features = spec.features
  if (!Array.isArray(features)) return []
  const ids = new Set<string>()
  for (const f of features) {
    if (!f || typeof f !== 'object') continue
    const feature = f as Record<string, unknown>
    if (feature.kind !== 'import_step') continue
    const id = feature.file_id
    if (typeof id === 'string' && id) ids.add(id)
  }
  return [...ids]
}

export function fileIdsInParts(parts: AssemblyExportPartSpec[]): string[] {
  const ids = new Set<string>()
  for (const part of parts) {
    for (const id of fileIdsInSpec(part.spec)) ids.add(id)
  }
  return [...ids]
}

// Bytes by id, resolved on the main thread. The kernel receives this map; it
// never reaches back into storage.
export async function resolveFiles(registry: FileRegistry, ids: string[]): Promise<FileBytes> {
  const out: FileBytes = {}
  for (const id of ids) {
    const bytes = await registry.getBytes(id)
    if (bytes) out[id] = bytes
  }
  return out
}

// The one shared resolver for part solve, part export and assembly export. A
// live workspace session is authoritative: a STEP adopted from a folder/zip/
// .oversolved lives in the workspace, not the flat registry, and a replace of
// its bytes lands there too. `session.resolveFile` already falls back to the
// registry for a STEP an import just staged but the workspace has not adopted
// yet, so the registry below only fires when no workspace is open.
export async function resolveFilesSessionFirst(
  resolver: FileResolver | null,
  registry: FileRegistry,
  ids: string[],
): Promise<FileBytes> {
  const out: FileBytes = {}
  for (const id of ids) {
    const bytes = resolver ? await resolver.resolveFile(id) : await registry.getBytes(id)
    if (bytes) out[id] = bytes
  }
  return out
}
