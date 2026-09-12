// STEP document synthesis. A STEP file's bytes are adopted as a workspace file
// entry and its synthesized part document carries only that file id; the WASM
// kernel parses the bytes from the solve file map (occ/stepIo). The file-backed
// library's `importStepFile` is gone with the library seam -- adoption
// (`workspace/import.ts`) is the one way a bag becomes a document, and it calls
// `buildStepContent` below.

import { stringify as stringifyYaml } from 'yaml'
import type { PartDoc } from '@/types/cad'
import { BUILTIN_FEATURE_DEFAULTS } from '@/utils/builtins'
import { applyAddImportStep, randomId } from '@/utils/yamlMutations'
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
