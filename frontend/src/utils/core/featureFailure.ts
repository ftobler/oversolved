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
 * over. Two statuses are not failures:
 *   - a sketch's `status` is its CONSTRAINT state (`fully_constrained` /
 *     `underconstrained` / `overconstrained`, kernel/features/sketch.ts), never
 *     `'ok'` -- the naive test reddens every sketch in the document;
 *   - `'suppressed'` (kernel/builder.ts) is the user switching a feature off,
 *     which used to render as red AND struck through at the same time.
 * Both are excluded by name, the sketch words imported from the codec that
 * produces them so the two cannot drift. Anything else unrecognised counts as a
 * failure, so a status word invented later shows up rather than disappearing --
 * `'error'` (extrude/revolve "no closed profile") is already such a word.
 */
import { isBodyFeatureResult } from '@/types/cad'
import { STATUS_NAME } from '@/wasm-kernel/codec'

/** Statuses that report a state rather than a pass/fail. */
const NON_FAILURE_STATUSES: ReadonlySet<string> = new Set<string>([...STATUS_NAME, 'suppressed'])

export interface FeatureFailure {
  // True when the feature should render as failed.
  failed: boolean
  // How failed: 'warning' means the feature built something valid but only
  // partially fulfilled its intent (status 'partial' -- some picks resolved,
  // the rest need re-picking); 'error' means nothing built or invalid geometry.
  // null when not failed.
  level: 'error' | 'warning' | null
  // Human-readable cause, '' when the result carried none.
  message: string
}

const OK: FeatureFailure = { failed: false, level: null, message: '' }

/**
 * Whether `featureId` failed in the last solve, and why.
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
 * red of an `exception`.
 */
export function featureFailure(
  featureId: string,
  solveResults: Record<string, unknown> | undefined | null,
  bodies: Record<string, { mesh_error?: string }> | undefined | null,
): FeatureFailure {
  const result = solveResults?.[featureId]
  if (typeof result !== 'object' || result === null) return OK

  const bodyResult = isBodyFeatureResult(result) ? result : undefined
  const bodyIds = bodyResult
    ? (bodyResult.body_ids ?? (bodyResult.body_id ? [bodyResult.body_id] : []))
    : []
  const meshError = bodyIds.map(bid => bodies?.[bid]?.mesh_error).find(m => !!m)

  const status = (result as { status?: unknown }).status
  const statusFailed = typeof status === 'string'
    && status !== 'ok'
    && !NON_FAILURE_STATUSES.has(status)

  if (!statusFailed && !meshError) return OK

  const exception = (result as { exception?: unknown }).exception
  return {
    failed: true,
    // Only the kernel's own 'partial' status is a warning; anything else that
    // failed -- including a partial result whose own body will not tessellate
    // (mesh_error) -- is an error.
    level: status === 'partial' && !meshError ? 'warning' : 'error',
    message: (typeof exception === 'string' ? exception : undefined) ?? meshError ?? '',
  }
}
