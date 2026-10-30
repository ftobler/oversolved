// The document-handle operations shared by the MCP entry script: resolve a
// `doc`/`docHash`/`parts` argument against the store and build the `run`
// replies. They live here, free of I/O, so the handle contract is unit-testable
// without the kernel.
//
// An assembly handle is composite (D2): the binding (doc_id -> part content)
// travels with it, and a `parts` merge on an existing handle overrides one
// binding and yields a new hash.

import type { AssemblyDoc, PartDoc } from '@/types/cad'
import { CURRENT_DOC_VERSION, docLoadErrorMessage, loadAssemblyDoc, loadPartDoc } from '@/persistence/docSchema'
import { DocHandleStore, DOC_HANDLE_CAPACITY, assemblyHandleOf } from '@/drive/docHandleStore'
import { docHashOf } from '@/drive/docHash'
import { formatFeatureProblem, type FeatureProblem } from '@/drive/featureOutcome'
import type { FeatureDelta } from '@/drive/featureDeltas'
import type { FeatureFrameMap } from '@/drive/featureFrames'
import type { McpDocArguments } from '@/drive/mcpServer'
import type { AssemblyPartProblem, InstancePose, MateFrame, MateProblem } from '@/drive/assemblyOutcome'
import type { AssemblySolveStatus } from '@/kernel/solveAssembly'
import { shapeAssemblyState, shapeSteps, type AssemblyDetail, type AssemblyDetailContext } from '@/drive/assemblyDetail'

export type ResolvedDoc =
  | { ok: true; kind: 'part'; doc: PartDoc; docHash: string }
  | { ok: true; kind: 'assembly'; doc: AssemblyDoc; parts: Record<string, PartDoc>; docHash: string }
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

export function stampLoadedAssemblyDoc(doc: AssemblyDoc): AssemblyDoc {
  doc.version = Math.max(CURRENT_DOC_VERSION, doc.version ?? 0)
  return doc
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Resolve the `parts` binding: a part docHash or an inline `{doc}` per doc_id. */
function resolveBinding(
  raw: unknown,
  documents: DocHandleStore,
): { ok: true; parts: Record<string, PartDoc> } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, parts: {} }
  if (!isRecord(raw)) return { ok: false, error: 'field "parts" must be an object mapping doc_id to a part docHash or {doc}' }
  const parts: Record<string, PartDoc> = {}
  for (const [docId, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      const entry = documents.getEntry(value)
      if (!entry) {
        return {
          ok: false,
          error: `parts.${docId}: unknown part docHash (the server keeps the last ${DOC_HANDLE_CAPACITY} documents); pass {doc} instead`,
        }
      }
      if (entry.kind === 'assembly') {
        return { ok: false, error: `parts.${docId}: an assembly cannot be a part; sub-assemblies are not supported` }
      }
      parts[docId] = entry.doc
      continue
    }
    if (isRecord(value) && value.doc !== undefined) {
      const docHash = docHashOf(value.doc)
      const loaded = loadPartDoc(value.doc, { name: `parts.${docId}` })
      if (!loaded.ok) return { ok: false, error: docLoadErrorMessage(loaded.error) }
      const doc = stampLoadedDoc(loaded.doc)
      documents.putAs(docHash, doc)
      parts[docId] = doc
      continue
    }
    return {
      ok: false,
      error: `parts.${docId} must be a part docHash string or an object with a "doc" field`,
    }
  }
  return { ok: true, parts }
}

function unboundProblem(doc: AssemblyDoc, parts: Record<string, PartDoc>): string | null {
  const bound = new Set(Object.keys(parts))
  const unbound = new Set<string>()
  for (const feature of doc.features ?? []) {
    if (feature.kind === 'part_instance' && feature.instance && !bound.has(feature.instance.doc_id)) {
      unbound.add(feature.instance.doc_id)
    }
  }
  if (unbound.size === 0) return null
  return `the assembly references unbound part(s): ${[...unbound].sort().join(', ')}; `
    + `bound parts: ${[...bound].sort().join(', ') || 'none'}. Bind each doc_id with the run call's \`parts\` argument.`
}

export function resolveAssemblyDoc(
  rawDoc: unknown,
  rawParts: unknown,
  documents: DocHandleStore,
): ResolvedDoc {
  const loaded = loadAssemblyDoc(rawDoc, { name: 'mcp' })
  if (!loaded.ok) return { ok: false, error: docLoadErrorMessage(loaded.error) }
  const doc = stampLoadedAssemblyDoc(loaded.doc)
  const binding = resolveBinding(rawParts, documents)
  if (!binding.ok) return binding
  const unbound = unboundProblem(doc, binding.parts)
  if (unbound !== null) return { ok: false, error: unbound }
  documents.putAssembly(doc, binding.parts)
  // The stored handle is the composite one; the raw doc's hash only named the
  // payload the client sent and is not a valid handle for an assembly.
  const handle = assemblyHandleOf(doc, binding.parts)
  return { ok: true, kind: 'assembly', doc, parts: binding.parts, docHash: handle }
}

/** Resolve the argument pair, storing a full doc under its content hash. */
export function resolveDoc(req: McpDocArguments, documents: DocHandleStore): ResolvedDoc {
  if (req.docHash !== undefined) {
    const entry = documents.getEntry(req.docHash)
    if (!entry) {
      return {
        ok: false,
        error: `unknown docHash (the server keeps the last ${DOC_HANDLE_CAPACITY} documents); pass doc instead`,
      }
    }
    if (entry.kind === 'part') {
      if (req.parts !== undefined) {
        return { ok: false, error: 'field "parts" applies only to an assembly document' }
      }
      return { ok: true, kind: 'part', doc: entry.doc, docHash: req.docHash }
    }
    if (req.parts === undefined) {
      return { ok: true, kind: 'assembly', doc: entry.doc, parts: entry.parts, docHash: req.docHash }
    }
    const overrides = resolveBinding(req.parts, documents)
    if (!overrides.ok) return overrides
    const merged = { ...entry.parts, ...overrides.parts }
    const unbound = unboundProblem(entry.doc, merged)
    if (unbound !== null) return { ok: false, error: unbound }
    if (Object.keys(overrides.parts).length === 0) {
      return { ok: true, kind: 'assembly', doc: entry.doc, parts: merged, docHash: req.docHash }
    }
    const docHash = documents.putAssembly(entry.doc, merged)
    return { ok: true, kind: 'assembly', doc: entry.doc, parts: merged, docHash }
  }
  if (req.doc === undefined) return { ok: false, error: 'no document: pass doc or docHash' }
  const isAssembly = req.kind === 'assembly' || (isRecord(req.doc) && req.doc.kind === 'assembly')
  if (isAssembly) return resolveAssemblyDoc(req.doc, req.parts, documents)
  if (req.parts !== undefined) return { ok: false, error: 'field "parts" applies only to an assembly document' }
  // The loader migrates in place, so the raw hash must be taken first: the
  // handle names the payload the client sent, not the loader's normalized copy.
  const docHash = docHashOf(req.doc)
  const loaded = loadPartDoc(req.doc, { name: 'mcp' })
  if (!loaded.ok) return { ok: false, error: docLoadErrorMessage(loaded.error) }
  const doc = stampLoadedDoc(loaded.doc)
  documents.putAs(docHash, doc)
  return { ok: true, kind: 'part', doc, docHash }
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

/**
 * A tool that only understands parts (select) refuses an assembly handle by
 * naming the part handles the assembly reply carries. The message is the one
 * the tool surface documents, so it lives here beside the resolve it reads.
 */
export function requirePartDoc(
  resolved: ResolvedDoc,
  tool: string,
): { ok: true; doc: PartDoc; docHash: string } | { ok: false; error: string } {
  if (!resolved.ok) return { ok: false, error: resolved.error }
  if (resolved.kind === 'assembly') {
    return {
      ok: false,
      error: `${tool} runs on a part document; pass the part's docHash (see the assembly's \`parts\`)`,
    }
  }
  return { ok: true, doc: resolved.doc, docHash: resolved.docHash }
}

export interface AssemblyRunReplySource {  ok: boolean
  outcome: { steps: unknown[] }
  doc: AssemblyDoc
  // The binding the run used, so the composite handle can be minted.
  binding: ReadonlyMap<string, PartDoc> | Record<string, PartDoc>
  solve: AssemblySolveStatus
  mates: MateProblem[]
  partProblems: AssemblyPartProblem[]
  instances: InstancePose[]
  mateFrames: Record<string, MateFrame>
  summary: string
}

/**
 * Build an assembly `run` reply: the composite handle, the solve state, the
 * problem lists, the solved poses and the mate frames, with the document only
 * when the caller opts in.
 */
export function assemblyRunReply(
  result: AssemblyRunReplySource,
  returnDoc: boolean,
  documents: DocHandleStore,
  shaping: { detail: AssemblyDetail; context: AssemblyDetailContext } = {
    detail: 'full',
    context: { inputDoc: null, baseline: null },
  },
): { ok: boolean; [key: string]: unknown } {
  const binding = result.binding instanceof Map
    ? Object.fromEntries(result.binding)
    : result.binding
  const docHash = documents.putAssembly(result.doc, binding)
  const state = shapeAssemblyState({
    solve: result.solve,
    mates: result.mates,
    parts: result.partProblems,
    instances: result.instances,
    mateFrames: result.mateFrames,
    summary: result.summary,
  }, shaping.detail, result.doc, shaping.context)
  return {
    ok: result.ok,
    kind: 'assembly',
    ...shapeSteps(result.outcome.steps as { ok: boolean }[], shaping.detail),
    docHash,
    solve: state.solve,
    mates: state.mates,
    parts: state.parts,
    ...(state.instances !== undefined && { instances: state.instances }),
    ...(state.mateFrames !== undefined && { mateFrames: state.mateFrames }),
    summary: state.summary,
    ...(returnDoc && { doc: result.doc }),
  }
}
