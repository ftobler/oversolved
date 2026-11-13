// The per-feature solve outcome as it crosses the drive boundary (the node CLI
// and the MCP server). The kernel already answers per feature, but a feature
// that threw or only partly applied used to reduce to its status word and even
// that was dropped before the reply; `run` then looked clean while a hole had
// cut nothing. These helpers keep the outcome (status plus the kernel's own
// exception and warning text) and name the features a caller has to look at.

import type { BuildResponse, PartDoc } from '@/types/cad'
import { BUILTIN_FEATURE_IDS } from '@/utils/builtins'
import { STATUS_NAME, Status } from '@/wasm-kernel/codec'

/** What the last solve said about one feature. */
export interface FeatureOutcome {
  status: string
  // The kernel's reason, present on 'exception' and on 'partial' (the sites
  // that did not apply).
  exception?: string
  // The kernel's fallback or no-op note on an otherwise good solve, e.g. a
  // hole whose every drill site missed.
  warning?: string
  // An informational note on a clean solve: the geometry is what the document
  // asks for and the text only measures it, e.g. the tangent chain a fillet
  // ran along. Neither a problem nor a warning, so it never makes `ok` false
  // and never leaves the feature out of the delta rows.
  note?: string
  // A warning an earlier feature emitted that a later feature made moot, e.g.
  // an "also touches ... add a boolean union" the later union resolved. The
  // problem list ignores it; the note channel reports it so the history is
  // visible without calling it a failure.
  resolvedWarning?: string
  // The side a hole drilled, as the kernel resolved it. A through hole under
  // `normal` drills wherever its sites find material, so this can differ from
  // the authored field, and a counterbore on the wrong side is otherwise only
  // visible by measuring its faces.
  direction?: 'normal' | 'reverse'
  // The body the feature built or changed (the kernel's `body_id`), e.g. the
  // merge_target an extrude cut went into.
  bodyId?: string
  // A sketch's remaining degrees of freedom. An underconstrained sketch reads
  // this count in its warning; the delta row repeats it so an author sees the
  // number shrink as constraints land.
  dof?: number
}

/** A feature the solve did not finish cleanly, in feature log order. */
export interface FeatureProblem {
  id: string
  kind: string
  status: string
  message: string
}

/**
 * One informational note about the solve, in the reply's `notes` list. The
 * text is the kernel's own or the drive's, and the ids name the features it is
 * about in feature log order: a solve note names its feature, a same-query
 * frame conflict names both sketches and therefore sorts at the later one.
 */
export interface FeatureNote {
  ids: string[]
  text: string
}

// The statuses that are a pass or a chosen state rather than a failure. The
// words come from the result types, not from guessing: 'ok' is
// BodyFeatureResult's success, the two sketch verdicts are the satisfiable
// entries of STATUS_NAME (wasm-kernel/codec.ts; the third, 'overconstrained',
// is a failed solve and is deliberately absent), and 'suppressed' is the
// builder's user-disabled feature. Everything else -- 'exception', 'partial',
// extrude/revolve's 'error', and any word a later kernel adds -- is a problem,
// so a new status shows up in the reply instead of disappearing.
const NON_PROBLEM_STATUSES: ReadonlySet<string> = new Set<string>([
  'ok',
  'fully_constrained',
  'underconstrained',
  'suppressed',
])

/** The status surfaced for a feature the settle gave no verdict at all. Not a
 *  kernel status: it is the drive boundary's own answer to a silent result. */
export const MISSING_VERDICT_STATUS = 'missing'
export const MISSING_VERDICT_MESSAGE = 'no verdict from the solve'

/**
 * Whether a per-feature outcome is something the caller must read. A warning
 * alone is a problem too: the kernel took a fallback or removed no material,
 * which is exactly the silent success this reply exists to surface. An
 * informational `note` is not: it describes geometry the solve did build.
 */
export function isFeatureProblem(outcome: FeatureOutcome): boolean {
  return outcome.warning !== undefined || !NON_PROBLEM_STATUSES.has(outcome.status)
}

/**
 * Whether the kernel built geometry for this feature, even if it also said
 * something about it. A warning is a problem row the caller must read, but the
 * checkpoint still holds the geometry the feature built, so a delta row can
 * describe it. The status vocabulary stays here so a reply never re-lists the
 * clean words and silently drops a status a later kernel adds.
 */
export function isBuiltOutcome(outcome: FeatureOutcome): boolean {
  return outcome.exception === undefined && NON_PROBLEM_STATUSES.has(outcome.status)
}

/**
 * Whether a problem row must fail an export. A sketch build warning is
 * tolerated in a file: an underconstrained sketch still has sound geometry, and
 * a fully constrained sketch carrying an ignored-constraint warning is a
 * complete sketch with one dead row. Refusing either would make a yellow build
 * mark a hard export error by the back door. A built shell's corner
 * substitution is the same kind of row: the asked-for sharp join was replaced
 * by a rounded one, but the solid is valid and the geometry is complete, so the
 * warning marks the tree without failing the file. An overconstrained sketch is
 * a failed solve, and every other row the problem list carries -- a partial or
 * failed sibling, a missing verdict -- still fails it.
 */
export function blocksExport(problem: FeatureProblem): boolean {
  const toleratedSketch = problem.kind === 'sketch'
    && (problem.status === STATUS_NAME[Status.underconstrained]
      || problem.status === STATUS_NAME[Status.fully_constrained])
  const toleratedShell = problem.kind === 'shell' && problem.status === 'ok'
  return !toleratedSketch && !toleratedShell
}

/**
 * The per-feature outcomes in a solve response. A feature without a string
 * status (null, a geometry-only row) is left out, matching the old
 * solveStatuses contract: the map only carries real verdicts.
 */
export function readSolveOutcomes(
  result: BuildResponse['result'] | null | undefined,
): Record<string, FeatureOutcome> {
  const outcomes: Record<string, FeatureOutcome> = {}
  for (const [id, feature] of Object.entries(result ?? {})) {
    if (typeof feature !== 'object' || feature === null) continue
    const row = feature as {
      status?: unknown; exception?: unknown; solver_warning?: unknown; solver_note?: unknown
      resolved_warning?: unknown; direction?: unknown; body_id?: unknown; dof?: unknown
    }
    if (typeof row.status !== 'string') continue
    const exception = typeof row.exception === 'string' && row.exception !== '' ? row.exception : undefined
    const warning = typeof row.solver_warning === 'string' && row.solver_warning !== '' ? row.solver_warning : undefined
    const note = typeof row.solver_note === 'string' && row.solver_note !== '' ? row.solver_note : undefined
    const resolvedWarning = typeof row.resolved_warning === 'string' && row.resolved_warning !== ''
      ? row.resolved_warning
      : undefined
    // Only the hole result writes this field; anything but a drill side word
    // is not one and is dropped rather than echoed.
    const direction = row.direction === 'normal' || row.direction === 'reverse' ? row.direction : undefined
    const bodyId = typeof row.body_id === 'string' && row.body_id !== '' ? row.body_id : undefined
    const dof = typeof row.dof === 'number' && Number.isFinite(row.dof) ? row.dof : undefined
    outcomes[id] = {
      status: row.status,
      ...(exception !== undefined && { exception }),
      ...(warning !== undefined && { warning }),
      ...(note !== undefined && { note }),
      ...(resolvedWarning !== undefined && { resolvedWarning }),
      ...(direction !== undefined && { direction }),
      ...(bodyId !== undefined && { bodyId }),
      ...(dof !== undefined && { dof }),
    }
  }
  return outcomes
}

function defaultMessage(status: string): string {
  if (status === 'overconstrained') return 'the sketch is overconstrained'
  if (status === 'partial') return 'the feature applied only part of its work'
  if (status === 'exception' || status === 'error') return 'the feature failed to build'
  return `the solver reported status '${status}'`
}

/**
 * The problems a caller must act on, in feature log order so the list reads
 * like the tree. Kind comes from the document because a solve result carries
 * the id only.
 *
 * Every non-builtin, non-suppressed feature of the solved document must have a
 * verdict after a settle. A missing one is a problem row, not an absence: a
 * solve that returned an empty result (the wedged-kernel signature) used to
 * read as a clean build because there was simply nothing to report. Builtins
 * are display-only and never reach the kernel; suppressed features are
 * deliberately skipped by the builder, and when they were reached they already
 * carry their own `suppressed` verdict.
 *
 * Rollback is not a case here: the drive boundary always solves the whole
 * authored stack (`partSolvePayload` sets rollback_position to its length).
 */
export function featureProblems(
  doc: PartDoc,
  outcomes: Record<string, FeatureOutcome>,
): FeatureProblem[] {
  const problems: FeatureProblem[] = []
  for (const feature of doc.features ?? []) {
    const id = typeof feature.id === 'string' ? feature.id : ''
    if (id === '') continue
    if (BUILTIN_FEATURE_IDS.has(id)) continue
    if (feature.suppressed === true) continue
    const kind = typeof feature.kind === 'string' ? feature.kind : 'unknown'
    const outcome = outcomes[id]
    if (outcome === undefined) {
      problems.push({
        id,
        kind,
        status: MISSING_VERDICT_STATUS,
        message: MISSING_VERDICT_MESSAGE,
      })
      continue
    }
    if (!isFeatureProblem(outcome)) continue
    problems.push({
      id,
      kind,
      status: outcome.status,
      message: outcome.exception ?? outcome.warning ?? defaultMessage(outcome.status),
    })
  }
  return problems
}

/**
 * The informational notes of a solve, in feature log order. A feature can
 * contribute two: the kernel's own informational text and a warning an earlier
 * feature made moot. `extra` carries the notes the drive derives itself (the
 * same-query frame conflict), which name more than one feature and sort at the
 * last id they name.
 *
 * Notes are not problems: a note never adds a `features` row, never makes `ok`
 * false and never drops a delta row. An empty list is the clean answer.
 */
export function featureNotes(
  doc: PartDoc,
  outcomes: Record<string, FeatureOutcome>,
  extra: readonly FeatureNote[] = [],
): FeatureNote[] {
  const notes: FeatureNote[] = []
  const features = doc.features ?? []
  for (const feature of features) {
    const id = typeof feature.id === 'string' ? feature.id : ''
    if (id === '') continue
    if (BUILTIN_FEATURE_IDS.has(id)) continue
    if (feature.suppressed === true) continue
    const outcome = outcomes[id]
    if (outcome === undefined) continue
    if (outcome.note !== undefined) notes.push({ ids: [id], text: outcome.note })
    // The same informational class: the warning was real when it fired and a
    // later feature resolved it. The problem list already ignores it, so the
    // note channel is where a caller can still read what happened.
    if (outcome.resolvedWarning !== undefined) notes.push({ ids: [id], text: outcome.resolvedWarning })
  }
  for (const note of extra) {
    if (note.ids.length === 0 || note.text === '') continue
    notes.push({ ids: [...note.ids], text: note.text })
  }
  // Stable, so two notes on one feature keep the order above. A note naming an
  // id the document does not hold still reaches the caller, at the end.
  const position = new Map<string, number>()
  features.forEach((feature, index) => {
    if (typeof feature.id === 'string') position.set(feature.id, index)
  })
  const docLength = features.length
  const lastPosition = (note: FeatureNote): number =>
    note.ids.map(id => position.get(id) ?? docLength).reduce((a, b) => Math.max(a, b), -1)
  return notes.sort((a, b) => lastPosition(a) - lastPosition(b))
}

/** One problem as it appears in the reply's one-line summary. */
export function formatFeatureProblem(problem: FeatureProblem): string {
  return `${problem.id} (${problem.kind}) ${problem.status}: ${problem.message}`
}
