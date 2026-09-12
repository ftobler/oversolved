// STEP import into a fresh document. NOT a second store -- this round-trips
// through whatever `DocumentStore` is wired in, like the bundle helpers. A STEP
// file's bytes go into the file registry (uuid-keyed, IndexedDB), and the
// document carries only the registry id. The WASM kernel parses the bytes from
// the solve file map (occ/stepIo) -- the same path Part.tsx uses to add an
// `import_step` feature to an open document.

import { stringify as stringifyYaml } from 'yaml'
import type { PartDoc } from '@/types/cad'
import type { DocumentStore } from './types'
import { BUILTIN_FEATURE_DEFAULTS } from '@/utils/builtins'
import { applyAddImportStep, randomId } from '@/utils/yamlMutations'
import { getFileRegistry } from '@/stores/fileRegistry'
import { formatBytes } from '@/utils/formatBytes'

// The cap bounds kernel memory: the ArrayBuffer read plus the OCC parse, the
// two largest transient allocations an import creates. No base64 string is ever
// built on this path, so the old 4/3 string inflation is gone.
export const MAX_STEP_IMPORT_BYTES = 75 * 1024 * 1024

/** Human-readable reason a file of this size cannot be imported, or null if it fits. */
export function stepImportLimitError(sizeBytes: number): string | null {
  if (sizeBytes <= MAX_STEP_IMPORT_BYTES) return null
  return `STEP file is too large (${formatBytes(sizeBytes)}); the limit is ${formatBytes(MAX_STEP_IMPORT_BYTES)}`
}

/**
 * Build the YAML document content for a fresh STEP import: the builtin
 * reference features (Origin + three planes, matching what a blank document
 * gets on first open) plus a single `import_step` feature carrying only the
 * registry file id. Pure so it is testable without a File or store.
 */
export function buildStepContent(
  fileId: string,
  featureId: string = randomId(18),
  label?: string,
): string {
  const doc: PartDoc = { features: BUILTIN_FEATURE_DEFAULTS.map(f => ({ ...f })) }
  applyAddImportStep(doc, featureId, fileId, label)
  return stringifyYaml(doc)
}

/**
 * Ingest a STEP file into the active store by creating a new document and
 * saving a reference to the registry record holding its bytes. Returns the new
 * document uuid.
 */
export async function importStepFile(store: DocumentStore, file: File): Promise<string> {
  // Size gate before any read: a rejected import must not allocate the
  // ArrayBuffer the kernel would then parse.
  const tooBig = stepImportLimitError(file.size)
  if (tooBig) throw new Error(tooBig)
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error('STEP file is empty')
  const name = file.name.replace(/\.(step|stp)$/i, '')
  if (!name) throw new Error('Invalid filename')
  const entry = await getFileRegistry().create({
    name: file.name,
    kind: 'step',
    mime: 'application/step',
    bytes,
  })
  const content = buildStepContent(entry.id, randomId(18), file.name)
  let uuid: string | undefined
  try {
    uuid = (await store.create(name)).uuid
    await store.save(uuid, { content })
  } catch (err) {
    // Compensating delete for the non-atomic registry + create + save sequence:
    // without it a failed create strands an empty orphan document, and any
    // failure strands the registry record holding the bytes.
    if (uuid !== undefined) await store.remove(uuid).catch(() => undefined)
    await getFileRegistry().remove(entry.id).catch(() => undefined)
    throw err
  }
  return uuid
}
