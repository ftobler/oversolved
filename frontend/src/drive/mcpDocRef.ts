// The document-handle operations shared by the MCP entry script: resolve a
// `doc`/`docHash` argument against the store and build the `run` reply. They
// live here, free of I/O, so the handle contract is unit-testable without the
// kernel.

import type { PartDoc } from '@/types/cad'
import { CURRENT_DOC_VERSION, docLoadErrorMessage, loadPartDoc } from '@/persistence/docSchema'
import { DocHandleStore, DOC_HANDLE_CAPACITY } from '@/drive/docHandleStore'
import { docHashOf } from '@/drive/docHash'
import { formatFeatureProblem, type FeatureProblem } from '@/drive/featureOutcome'
import type { FeatureDelta } from '@/drive/featureDeltas'
import type { FeatureFrameMap } from '@/drive/featureFrames'
import type { McpDocArguments } from '@/drive/mcpServer'

export type ResolvedDoc =
  | { ok: true; doc: PartDoc; docHash: string }
  | { ok: false; error: string }

/**
 * Stamp a document the loader accepted with the ladder version: loadPartDoc
 * migrated it, so it is current, and an older stamp left on it would rerun
 * the ladder on the reply's next reload and rewrite the `$` refs the run's own
 * mutations wrote since, moving the docHash of a mere inspect.
 */
export function stampLoadedDoc(doc: PartDoc): PartDoc {
  doc.version = Math.max(CURRENT_DOC_VERSION, doc.version ?? 0)
  return doc
}

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
  // The loader migrates in place, so the raw hash must be taken first: the
  // handle names the payload the client sent, not the loader's normalized copy.
  const docHash = docHashOf(req.doc)
  const loaded = loadPartDoc(req.doc, { name: 'mcp' })
  if (!loaded.ok) return { ok: false, error: docLoadErrorMessage(loaded.error) }
  const doc = stampLoadedDoc(loaded.doc)
  documents.putAs(docHash, doc)
  return { ok: true, doc, docHash }
}

// The reply's one-line index of what the script built. Body ids are the live
// bodies the final solve reported when the caller has them: part_style can
// keep a colour entry for a body a boolean or join consumed (an older document,
// or the browser's add-only reconcile), so its keys alone would name dead
// bodies. Feature ids and kinds come from the feature log. A refused
// step skips the solve (the script stops there), so there are no live bodies to
// report; saying "not solved" is honest where the part_style fallback is not.
export function summarizeDoc(
  doc: PartDoc,
  liveBodies?: readonly string[] | null,
  refusedStep?: number | null,
): string {
  const features = (doc.features ?? []).map(feature => `${feature.id} (${feature.kind})`)
  const bodies = refusedStep !== undefined && refusedStep !== null
    ? `not solved (step ${refusedStep} refused)`
    : (liveBodies ?? Object.keys(doc.part_style ?? {}))
      .join(', ') || 'none'
  return `features: ${features.length > 0 ? features.join(', ') : 'none'}; `
    + `bodies: ${bodies}`
}

// The refused step that stopped the script, as the index the outcomes carry.
// A failed step in the middle only appears when `continueOnError` let later
// steps run and solve, so it is not evidence that the final state is unsolved.
function stoppedStep(steps: readonly unknown[]): number | null {
  const last = steps[steps.length - 1]
  if (typeof last !== 'object' || last === null) return null
  const candidate = last as { index?: unknown; ok?: unknown }
  if (candidate.ok !== false) return null
  return typeof candidate.index === 'number' ? candidate.index : null
}

export interface RunReplySource {
  ok: boolean
  outcome: { steps: unknown[] }
  doc: PartDoc | null
  docHash: string | null
  solve: unknown
  // The final solve's live body ids; null or absent means no solve ran, so the
  // summary falls back to the document's part_style keys.
  bodies?: readonly string[] | null
  // The problems the solve reported (featureOutcome.featureProblems): a
  // feature can fail or warn while `ok` stays true, so this rides every reply.
  features: FeatureProblem[]
  // Per-feature volume/bbox for the features this run changed or touched; null
  // when no checkpoints were measurable (no kernel).
  featureDeltas?: FeatureDelta[] | null
  // The resolved sketch and plane frames of the final solve; null when no
  // solve ran.
  frames?: FeatureFrameMap | null
}

/**
 * Build the default `run` reply: a handle and a summary, with the document
 * only when the caller opts in. The final document is stored under its hash,
 * so `returnDoc: true` and a later docHash resolve to the same content.
 *
 * `ok` means the steps applied and the solve ran; a failed feature is data,
 * not a failed call. The features list and the summary's `problems:` suffix
 * are how a client that reads only one line still learns about it.
 */
export function runReply(
  result: RunReplySource,
  returnDoc: boolean,
  documents: DocHandleStore,
): { ok: boolean; [key: string]: unknown } {
  const finalDoc = result.doc
  const docHash = finalDoc ? documents.put(finalDoc) : result.docHash
  const features = result.features
  // A stopped script has no solve for its final, refused step, so the live-set
  // fallback would name whatever part_style last carried. Say so instead; a
  // script that continued past a failure (continueOnError) did solve later.
  const refusedStep = stoppedStep(result.outcome.steps)
  const summary = finalDoc
    ? summarizeDoc(finalDoc, result.bodies, refusedStep) + (features.length > 0 ? `; problems: ${features.map(formatFeatureProblem).join('; ')}` : '')
    : undefined
  return {
    ok: result.ok,
    steps: result.outcome.steps,
    docHash,
    solve: result.solve,
    features,
    ...(result.featureDeltas !== undefined && { featureDeltas: result.featureDeltas }),
    ...(result.frames !== undefined && result.frames !== null && { frames: result.frames }),
    ...(summary !== undefined && { summary }),
    ...(returnDoc && finalDoc && { doc: finalDoc }),
  }
}
