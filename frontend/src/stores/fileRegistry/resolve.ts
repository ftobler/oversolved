import type { FileBytes } from '@/kernel/worker/solverProtocol'
import type { AssemblyExportPartSpec } from '@/kernel/worker/solverProtocol'
import type { FileRegistry } from './types'

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
