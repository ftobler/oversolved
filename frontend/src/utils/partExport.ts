// Part export, main-thread side, without React. The editor's export dialog and
// the workspace list's row action both land here, so the two cannot drift on
// which features reach the kernel or where referenced STEP bytes come from.

import { parse as parseYaml } from 'yaml'
import { exportViaWorker } from '@/kernel/worker/solverClient'
import { fileIdsMissingFromWorker } from '@/kernel/worker/workerFiles'
import { getFileRegistry } from '@/stores/fileRegistry'
import { fileIdsInSpec, resolveFilesSessionFirst } from '@/stores/fileRegistry/resolve'
import { BUILTIN_FEATURE_IDS } from '@/utils/builtins'
import { migrateLegacyBodyPicks } from '@/utils/yamlMigrations'
import type { PartDoc } from '@/types/cad'

export type GeometryFormat = 'step' | 'stl'

export interface PartExportOptions {
  format: GeometryFormat
  // One body of the part, or null for the compound of all of them.
  bodyId: string | null
  tessellation: number
}

// Structural, so a live WorkspaceSession passes as is. Null means no workspace
// is open and the flat staging registry is the only place bytes can come from.
export interface FileResolver {
  resolveFile(fileId: string): Promise<Uint8Array | undefined>
}

// The kernel built nothing exportable. Its own type so callers can word it as
// the empty result it is rather than as a crash.
export class EmptyExportError extends Error {
  constructor() {
    super('no solid geometry to export')
    this.name = 'EmptyExportError'
  }
}

export function exportMime(format: GeometryFormat): string {
  return format === 'step' ? 'application/step' : 'model/stl'
}

// The spec the worker builds: the builtins are seeded by the kernel, not solved
// as features, which is what every build path strips them for.
export function partExportSpec(doc: Record<string, unknown>, id?: string): Record<string, unknown> {
  const features = Array.isArray(doc.features)
    ? (doc.features as { id: string }[]).filter(f => !BUILTIN_FEATURE_IDS.has(f.id))
    : []
  return { ...doc, ...(id ? { id } : {}), features }
}

// A stored part's text as a document, with the same legacy self-heal the part
// load seam applies: the worker reads only `bodies`, never a singular `body`.
// An empty text is a part that was created and never edited.
export function partSpecFromText(text: string): Record<string, unknown> {
  const doc = (parseYaml(text) ?? {}) as PartDoc
  migrateLegacyBodyPicks(doc)
  return doc as Record<string, unknown>
}

// Rebuild the part on the worker and serialise it. Only the referenced files
// the live worker generation does not already hold are read from storage.
export async function exportPartBytes(
  spec: Record<string, unknown>,
  options: PartExportOptions,
  resolver: FileResolver | null,
): Promise<Uint8Array> {
  const fileIds = fileIdsMissingFromWorker(fileIdsInSpec(spec))
  const files = fileIds.length ? await resolveFilesSessionFirst(resolver, getFileRegistry(), fileIds) : undefined
  const bytes = await exportViaWorker(spec, options, files)
  if (!bytes) throw new EmptyExportError()
  return bytes
}
