/**
 * The one place "did this feature fail?" is decided.
 *
 * The kernel already answers this uniformly: every leaf that throws is caught in
 * one spot (`kernel/builder.ts`, `result[fid] = {status: 'exception', exception}`),
 * so the failure signal never depends on the feature's KIND. The tree re-derived
 * it behind a hardcoded list of kinds instead, and a kind missing from that list
 * -- `delete_body`, `import_step`, `mirror`, `sketch`, `plane` -- could fail with
 * an exception and still render as a healthy feature. That is why this takes no
 * kind argument: reading the result for every kind is the whole point.
 *
 * `status !== 'ok'` is NOT the rule, and that is what the kind list was papering
 * over. Three statuses are not failures:
 *   - a sketch's `status` is its CONSTRAINT state (`fully_constrained` /
 *     `underconstrained` / `overconstrained`, kernel/features/sketch.ts), never
 *     `'ok'` -- the naive test reddens every sketch in the document;
 *   - `'suppressed'` (kernel/builder.ts) is the user switching a feature off,
 *     which used to render as red AND struck through at the same time.
 * The two satisfiable sketch words are a state, so they are excluded by name,
 * the words imported from the codec that produces them so the two cannot drift.
 * An underconstrained sketch still gets a mark -- yellow, through the kernel's
 * `solver_warning` -- because free geometry is a build warning; it is not a
 * failure, and it never fails an export. `overconstrained` is a genuinely
 * failed solve (the geometry is a compromise), so it falls to the error branch.
 * Anything else unrecognised counts as a failure, so a status word invented
 * later shows up rather than disappearing -- `'error'` (extrude/revolve "no
 * closed profile") is already such a word.
 */
import { isBodyFeatureResult } from '@/types/cad'
import { STATUS_NAME, Status } from '@/wasm-kernel/codec'
import { degenerateEntityWarning, type DegenerateEntity } from '@/utils/entitySizeProblems'
import { NO_MARK, type StatusMark } from './statusMark'

/** Statuses that report a satisfiable state rather than a pass/fail. */
const NON_FAILURE_STATUSES: ReadonlySet<string> = new Set<string>([
  STATUS_NAME[Status.fully_constrained],
  STATUS_NAME[Status.underconstrained],
  'suppressed',
])

// Shown when the kernel marked a feature but gave no words: a mark the user
// can see must always say something, in the tree tooltip and in the editor.
const DEFAULT_ERROR = 'The feature failed to build.'
const DEFAULT_WARNING = 'Only part of the feature was applied.'
// The drive's `defaultMessage` uses the same words for an overconstrained
// sketch, and the plan's law is that both boundaries say one thing.
const DEFAULT_OVERRICONSTRAINED = 'the sketch is overconstrained'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/**
 * The feature's item mark from the last solve: whether it failed, how badly,
 * and why. The tree row and the open editor both read this one answer.
 *
 * `bodies` is consulted because a feature can solve fine and still produce
 * geometry that will not tessellate. Any ONE of its bodies failing has to
 * redden the row: a feature owns every body it made
 * (kernel/features/bodySplit.ts), so reading only `body_id` left a split sibling
 * rendering nothing behind a healthy-looking feature.
 *
 * The severity split is intentional: a `partial` result (fillet/chamfer, hole,
 * extrude/revolve/sweep profile fan-out) built a valid solid from the picks that
 * resolved -- downstream stays solvable, so it is a warning, not the hard-error
 * red of an `exception`. A `solver_warning` on an otherwise 'ok' result is the
 * same kind of warning: the kernel took a fallback (an up-to target that did
 * not resolve became a blind distance) or the operation changed nothing, and
 * that note is the only trace of it. A `solver_note` is deliberately not read:
 * it reports geometry the solve did build (a blend's tangent chain), so it is
 * informational and gets no mark.
 */
export function featureFailure(
  featureId: string,
  solveResults: Record<string, unknown> | undefined | null,
  bodies: Record<string, { mesh_error?: string }> | undefined | null,
): StatusMark {
  const result = solveResults?.[featureId]
  if (typeof result !== 'object' || result === null) return NO_MARK

  const bodyResult = isBodyFeatureResult(result) ? result : undefined
  const bodyIds = bodyResult
    ? (bodyResult.body_ids ?? (bodyResult.body_id ? [bodyResult.body_id] : []))
    : []
  const meshError = bodyIds.map(bid => bodies?.[bid]?.mesh_error).find(m => !!m)

  const status = (result as { status?: unknown }).status
  const statusFailed = typeof status === 'string'
    && status !== 'ok'
    && !NON_FAILURE_STATUSES.has(status)

  const r = result as { exception?: unknown; solver_warning?: unknown; mesh_warning?: unknown }
  const exception = str(r.exception)
  const solverWarning = str(r.solver_warning)

  if (!statusFailed && !meshError) {
    // A good solve is unmarked unless the kernel noted a fallback on it. An
    // underconstrained sketch is the one warning that has not failed: the
    // geometry is sound, it just still has freedom.
    if (!solverWarning) return NO_MARK
    const underconstrained = status === STATUS_NAME[Status.underconstrained]
    return { failed: !underconstrained, level: 'warning', message: solverWarning }
  }

  // Only the kernel's own 'partial' status is a warning; anything else that
  // failed -- including a partial result whose own body will not tessellate
  // (mesh_error) -- is an error.
  if (status === 'partial' && !meshError) {
    const notes = [exception, solverWarning].filter((m): m is string => m !== undefined)
    return { failed: true, level: 'warning', message: notes.length > 0 ? notes.join('; ') : DEFAULT_WARNING }
  }
  // An overconstrained sketch is the verdict the tree used to hide entirely.
  // Its result carries the culprit constraints the solve could not satisfy, so
  // the message names how many are in conflict instead of a generic line. A
  // degenerate entity is a different cause: it must name itself here, because
  // "the sketch is overconstrained" is true but tells the author nothing to fix.
  // Only the structured degenerate list earns that replacement; an ignored
  // constraint or an unresolved projection can ride beside a real conflict and
  // must keep the culprit count.
  if (status === 'overconstrained') {
    const rawDegenerate = (result as { degenerate_entities?: unknown }).degenerate_entities
    const degenerate = Array.isArray(rawDegenerate)
      ? rawDegenerate.filter((entry): entry is DegenerateEntity =>
          typeof entry === 'object' && entry !== null
          && typeof (entry as { id?: unknown }).id === 'string'
          && typeof (entry as { reason?: unknown }).reason === 'string')
      : []
    if (degenerate.length > 0) {
      return {
        failed: true,
        level: 'error',
        message: degenerate.map(entry => degenerateEntityWarning(entry.id, entry.reason)).join(' '),
      }
    }
    const constraints = (result as { constraints?: Record<string, { culprit?: unknown }> }).constraints
    const culprits = constraints === undefined
      ? 0
      : Object.values(constraints).filter(c => c?.culprit === true).length
    const which = culprits > 0
      ? ` (${culprits} conflicting constraint${culprits === 1 ? '' : 's'})`
      : ''
    return { failed: true, level: 'error', message: `${DEFAULT_OVERRICONSTRAINED}${which}` }
  }
  return {
    failed: true,
    level: 'error',
    message: exception ?? meshError ?? str(r.mesh_warning) ?? DEFAULT_ERROR,
  }
}
