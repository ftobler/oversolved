// STEP import into a fresh document. NOT a second store -- this round-trips
// through whatever `DocumentStore` is wired in, like the bundle helpers. A STEP
// file is read in-browser as base64 and the WASM kernel decodes it directly
// (occ/stepIo) -- the same path Part.tsx uses to add an `import_step` feature to
// an open document.

import { stringify as stringifyYaml } from 'yaml'
import type { PartDoc } from '@/types/cad'
import type { DocumentStore } from './types'
import { BUILTIN_FEATURE_DEFAULTS } from '@/utils/builtins'
import { applyAddImportStep, randomId } from '@/utils/yamlMutations'

// The STEP bytes ride inside the document YAML as base64 (4/3 inflation), so a
// 75MB file already becomes a ~100MB document string. The cap exists for the
// ~3-4x transient memory fan-out of read + encode + clone, which is what
// actually kills the tab on a large import.
export const MAX_STEP_IMPORT_BYTES = 75 * 1024 * 1024

/** Human-readable reason a file of this size cannot be imported, or null if it fits. */
export function stepImportLimitError(sizeBytes: number): string | null {
  if (sizeBytes <= MAX_STEP_IMPORT_BYTES) return null
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(1)
  return `STEP file is too large (${mb(sizeBytes)} MB); the limit is ${mb(MAX_STEP_IMPORT_BYTES)} MB`
}

/** Read a Blob/File as base64 (without the data: URL prefix). */
function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'))
    reader.readAsDataURL(file)
  })
}

/**
 * Build the YAML document content for a fresh STEP import: the builtin
 * reference features (Origin + three planes, matching what a blank document
 * gets on first open) plus a single `import_step` feature carrying the inline
 * base64 bytes. Pure so it is testable without a File or store.
 */
export function buildStepContent(
  fileDataB64: string,
  featureId: string = randomId(18),
  label?: string,
): string {
  const doc: PartDoc = { features: BUILTIN_FEATURE_DEFAULTS.map(f => ({ ...f })) }
  applyAddImportStep(doc, featureId, undefined, label, fileDataB64)
  return stringifyYaml(doc)
}

/**
 * Ingest a STEP file into the active store by creating a new document and
 * saving the import-step payload. Returns the new document uuid.
 */
export async function importStepFile(store: DocumentStore, file: File): Promise<string> {
  // Size gate before any read: a rejected import must not pay the base64
  // encode or allocate its fan-out first.
  const tooBig = stepImportLimitError(file.size)
  if (tooBig) throw new Error(tooBig)
  const fileData = await readFileAsBase64(file)
  if (!fileData) throw new Error('STEP file is empty')
  const name = file.name.replace(/\.(step|stp)$/i, '')
  if (!name) throw new Error('Invalid filename')
  const content = buildStepContent(fileData, randomId(18), file.name)
  const { uuid } = await store.create(name)
  try {
    await store.save(uuid, { content })
  } catch (err) {
    // Compensating delete for the non-atomic create+save pair: without it a
    // failed save strands an empty orphan document in the library.
    await store.remove(uuid).catch(() => undefined)
    throw err
  }
  return uuid
}