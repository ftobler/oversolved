// The document-handle operations shared by the MCP entry script: resolve a
// `doc`/`docHash` argument against the store and build the `run` reply. They
// live here, free of I/O, so the handle contract is unit-testable without the
// kernel.

import type { PartDoc } from '@/types/cad'
import { docLoadErrorMessage, loadPartDoc } from '@/persistence/docSchema'
import { DocHandleStore, DOC_HANDLE_CAPACITY } from '@/drive/docHandleStore'

export interface McpDocArguments {
  doc?: unknown
  docHash?: string
}

export type ResolvedDoc =
  | { ok: true; doc: PartDoc; docHash: string }
  | { ok: false; error: string }

/** Resolve the argument pair, storing a full doc under its content hash. */
export function resolveDoc(req: McpDocArguments, documents: DocHandleStore): ResolvedDoc {
  if (req.docHash !== undefined) {
    const doc = documents.get(req.docHash)
    if (!doc) {
      return {
        ok: false,
        error: `unknown docHash (the server keeps the last ${DOC_HANDLE_CAPACITY} documents); pass doc instead`,
      }
    }
    return { ok: true, doc, docHash: req.docHash }
  }
  if (req.doc === undefined) return { ok: false, error: 'no document: pass doc or docHash' }
  const loaded = loadPartDoc(req.doc, { name: 'mcp' })
  if (!loaded.ok) return { ok: false, error: docLoadErrorMessage(loaded.error) }
  return { ok: true, doc: loaded.doc, docHash: documents.put(loaded.doc) }
}

// The reply's one-line index of what the script built. Body ids are the
// part_style keys (the solve write-back reconciles one entry per body);
// feature ids and kinds come from the feature log.
export function summarizeDoc(doc: PartDoc): string {
  const features = (doc.features ?? []).map(feature => `${feature.id} (${feature.kind})`)
  const bodies = Object.keys(doc.part_style ?? {})
  return `features: ${features.length > 0 ? features.join(', ') : 'none'}; `
    + `bodies: ${bodies.length > 0 ? bodies.join(', ') : 'none'}`
}

export interface RunReplySource {
  ok: boolean
  outcome: { steps: unknown[] }
  doc: PartDoc | null
  docHash: string | null
  solve: unknown
}

/**
 * Build the default `run` reply: a handle and a summary, with the document
 * only when the caller opts in. The final document is stored under its hash,
 * so `returnDoc: true` and a later docHash resolve to the same content.
 */
export function runReply(
  result: RunReplySource,
  returnDoc: boolean,
  documents: DocHandleStore,
): { ok: boolean; [key: string]: unknown } {
  const finalDoc = result.doc
  const docHash = finalDoc ? documents.put(finalDoc) : result.docHash
  return {
    ok: result.ok,
    steps: result.outcome.steps,
    docHash,
    solve: result.solve,
    ...(finalDoc && { summary: summarizeDoc(finalDoc) }),
    ...(returnDoc && finalDoc && { doc: finalDoc }),
  }
}
