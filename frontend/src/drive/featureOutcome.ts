// The per-feature solve outcome as it crosses the drive boundary (the node CLI
// and the MCP server). The kernel already answers per feature, but a feature
// that threw or only partly applied used to reduce to its status word and even
// that was dropped before the reply; `run` then looked clean while a hole had
// cut nothing. These helpers keep the outcome (status plus the kernel's own
// exception and warning text) and name the features a caller has to look at.

import type { BuildResponse, PartDoc } from '@/types/cad'
import { BUILTIN_FEATURE_IDS } from '@/utils/builtins'

/** What the last solve said about one feature. */
export interface FeatureOutcome {
  status: string
  // The kernel's reason, present on 'exception' and on 'partial' (the sites
  // that did not apply).
  exception?: string
  // The kernel's fallback or no-op note on an otherwise good solve, e.g. a
  // hole whose every drill site missed.
  warning?: string
  // The side a hole drilled, as the kernel resolved it. A through hole under
  // `normal` drills wherever its sites find material, so this can differ from
  // the authored field, and a counterbore on the wrong side is otherwise only
  // visible by measuring its faces.
  direction?: 'normal' | 'reverse'
}

/** A feature the solve did not finish cleanly, in feature log order. */
export interface FeatureProblem {
  id: string
  kind: string
  status: string
  message: string
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
 * which is exactly the silent success this reply exists to surface.
 */
export function isFeatureProblem(outcome: FeatureOutcome): boolean {
  return outcome.warning !== undefined || !NON_PROBLEM_STATUSES.has(outcome.status)
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
    const row = feature as { status?: unknown; exception?: unknown; solver_warning?: unknown; direction?: unknown }
    if (typeof row.status !== 'string') continue
    const exception = typeof row.exception === 'string' && row.exception !== '' ? row.exception : undefined
    const warning = typeof row.solver_warning === 'string' && row.solver_warning !== '' ? row.solver_warning : undefined
    // Only the hole result writes this field; anything but a drill side word
    // is not one and is dropped rather than echoed.
    const direction = row.direction === 'normal' || row.direction === 'reverse' ? row.direction : undefined
    outcomes[id] = {
      status: row.status,
      ...(exception !== undefined && { exception }),
      ...(warning !== undefined && { warning }),
      ...(direction !== undefined && { direction }),
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

/** One problem as it appears in the reply's one-line summary. */
export function formatFeatureProblem(problem: FeatureProblem): string {
  return `${problem.id} (${problem.kind}) ${problem.status}: ${problem.message}`
}
