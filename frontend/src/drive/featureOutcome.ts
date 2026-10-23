// The per-feature solve outcome as it crosses the drive boundary (the node CLI
// and the MCP server). The kernel already answers per feature, but a feature
// that threw or only partly applied used to reduce to its status word and even
// that was dropped before the reply; `run` then looked clean while a hole had
// cut nothing. These helpers keep the outcome (status plus the kernel's own
// exception and warning text) and name the features a caller has to look at.

import type { BuildResponse, PartDoc } from '@/types/cad'

/** What the last solve said about one feature. */
export interface FeatureOutcome {
  status: string
  // The kernel's reason, present on 'exception' and on 'partial' (the sites
  // that did not apply).
  exception?: string
  // The kernel's fallback or no-op note on an otherwise good solve, e.g. a
  // hole whose every drill site missed.
  warning?: string
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
    const row = feature as { status?: unknown; exception?: unknown; solver_warning?: unknown }
    if (typeof row.status !== 'string') continue
    const exception = typeof row.exception === 'string' && row.exception !== '' ? row.exception : undefined
    const warning = typeof row.solver_warning === 'string' && row.solver_warning !== '' ? row.solver_warning : undefined
    outcomes[id] = {
      status: row.status,
      ...(exception !== undefined && { exception }),
      ...(warning !== undefined && { warning }),
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
 * the id only. Features the solve did not reach (rolled back, or after the
 * first failure) are absent, not guessed at.
 */
export function featureProblems(
  doc: PartDoc,
  outcomes: Record<string, FeatureOutcome>,
): FeatureProblem[] {
  const problems: FeatureProblem[] = []
  for (const feature of doc.features ?? []) {
    const id = typeof feature.id === 'string' ? feature.id : ''
    if (id === '') continue
    const outcome = outcomes[id]
    if (outcome === undefined || !isFeatureProblem(outcome)) continue
    const kind = typeof feature.kind === 'string' ? feature.kind : 'unknown'
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
