// The `out` contract for an assembly run. The workspace zip is the hand-off
// format: it carries the assembly, every bound part and every referenced file,
// so each part_instance.doc_id resolves after import. A bare YAML/JSON document
// is still written (inspection, a script that deliberately saves the tree), and
// the note says which part documents it leaves behind.

import type { AssemblyDoc } from '@/types/cad'
import type { FeatureNote } from '@/drive/featureOutcome'

/** The part documents the assembly instances name, sorted and deduped. */
export function assemblyPartDocIds(doc: AssemblyDoc): string[] {
  const ids = new Set<string>()
  for (const feature of doc.features ?? []) {
    if (feature.kind === 'part_instance' && feature.instance !== undefined) {
      ids.add(feature.instance.doc_id)
    }
  }
  return [...ids].sort()
}

const EXTENSION = /\.[^./\\]+$/

/** Whether a path asks for the workspace zip, by its extension. */
export function assemblyOutIsZip(file: string): boolean {
  return file.toLowerCase().endsWith('.zip')
}

/**
 * The path an assembly `out` writes. The zip is the default, so a path with no
 * extension, or one ending in a separator, gets `.zip`; an explicit extension
 * (such as `.json`, `.yaml` or `.zip`) stays as written. The rule reads the
 * caller's own spelling, because path resolution drops the trailing separator a
 * directory-style path carries. A single segment names an allowed root rather
 * than a file, so it is left to the resolver's own refusal.
 */
export function assemblyOutPath(out: string): string {
  // Leave an empty path to the resolver, whose error is the plain empty-path refusal.
  if (out.trim() === '') return out
  const base = out.replace(/[\\/]+$/, '')
  if (!base.includes('/') && !base.includes('\\')) return out
  return EXTENSION.test(base) ? base : `${base}.zip`
}

/**
 * Why a bare assembly file is not a self-contained hand-off: every instance
 * names a part document the file does not carry, so its `part_instance.doc_id`
 * values cannot resolve on import. Null when there is nothing to warn about (an
 * assembly with no instances).
 */
export function assemblyBareOutNote(doc: AssemblyDoc): FeatureNote | null {
  const ids = assemblyPartDocIds(doc)
  if (ids.length === 0) return null
  const documents = ids.length === 1 ? 'part document' : 'part documents'
  const verb = ids.length === 1 ? 'is' : 'are'
  return {
    ids,
    text: `The out file holds the assembly document alone: ${documents} ${ids.join(', ')} ${verb} not in it, `
      + 'so its part_instance doc_ids do not resolve. Use a .zip out for a self-contained hand-off '
      + '(the assembly plus every bound part and file).',
  }
}
