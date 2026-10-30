/**
 * The one place "what did the assembly solve decide?" is read for display.
 *
 * The assembly counterpart of `featureFailure.ts`. Every row mark and the one
 * banner ask these pure predicates, so no consumer re-derives failure from a
 * partial signal (`stale`, a throw, solveError) the way the tree used to.
 *
 * `AssemblySolveStatus` already carries the whole verdict: the Rust overall
 * status, the per-mate marks and the per-part bundle marks. These functions only
 * translate that object into a row mark, no React, no store, no viewport.
 */
import type { AssemblySolveStatus } from '@/kernel/solveAssembly'
import { NO_MARK, type StatusMark } from './statusMark'

/**
 * The rigid-mate acceptance tolerance (mm, or dimensionless for axes), matching
 * the plan's user-set 1e-4. The Rust solver's overall `mate_status` threshold is
 * relative to the drawing's characteristic length; this per-mate mark is the
 * absolute acceptance a single mate's weighted residual norm is held to.
 */
export const MATE_RESIDUAL_TOL = 1e-4

/** The shared item mark (utils/core/statusMark.ts) plus the assembly's cause. */
export interface AssemblyMark extends StatusMark {
  // Why a mate marked, so a consumer can pick the right row style without
  // re-deriving the cause ('stale' keeps the legacy unresolved-ref look, the
  // others redden the name with the specific message).
  cause?: 'error' | 'stale' | 'part'
}

const OK: AssemblyMark = NO_MARK

/**
 * Whether mate `id` failed in the last solve, and why.
 *
 * A model cause wins over a stale reference: a solver trap or an unsupported
 * mate kind is a real error the user can act on, and it must mark even though
 * `stale` is unset on the trap path. Only a bare unresolved reference falls
 * through to the re-pick advice.
 *
 * `refParts`, when given, are the mate's two referenced part handles. A mate
 * whose reference names a part that failed to load names that cause instead of
 * telling the user to re-pick geometry that is actually fine.
 */
export function mateFailure(
  id: string,
  status: AssemblySolveStatus | null,
  refParts?: readonly string[],
): AssemblyMark {
  const result = status?.mates[id]
  if (!result) return OK

  if (result.error) return { failed: true, level: 'error', message: result.error, cause: 'error' }

  const refPartFailed = refParts?.some(part => partFailure(part, status).failed)
  if (refPartFailed) {
    return { failed: true, level: 'error', message: 'The referenced part failed to load.', cause: 'part' }
  }

  if (result.stale) {
    return { failed: true, level: 'error', message: 'A reference no longer resolves; re-pick it.', cause: 'stale' }
  }

  // The solver's per-mate residual norm rides the output wire; a real mate that
  // did not converge inside the acceptance tolerance is marked here rather than
  // only in the overall verdict. A non-finite value is the solver's "dropped
  // mate" sentinel and is not a failure.
  if (
    typeof result.residual === 'number' &&
    Number.isFinite(result.residual) &&
    result.residual > MATE_RESIDUAL_TOL
  ) {
    // A non-converged solve is a reseed problem, not a conflict: say so, so
    // the user does not start deleting mates.
    if (status?.verdict === 'not_converged') {
      return {
        failed: true,
        level: 'warning',
        message: 'The solver did not reach this mate from the seed; reseed the part or check flip.',
        cause: 'error',
      }
    }
    return {
      failed: true,
      level: 'error',
      message: 'The mate is not holding to tolerance.',
      cause: 'error',
    }
  }
  return OK
}

/**
 * Whether part instance `handle` failed to load. Absent means healthy: only a
 * bundle that failed records an entry.
 */
export function partFailure(handle: string, status: AssemblySolveStatus | null): AssemblyMark {
  const result = status?.parts[handle]
  if (!result?.failed) return OK
  return { failed: true, level: 'error', message: result.error || 'The part failed to load.', cause: 'part' }
}

/**
 * The overall solve verdict as one mark for the assembly root row and banner.
 *
 * Overconstrained, failed and unavailable are hard errors. Underconstrained is
 * informational -- the assembly is valid, it just still has freedom -- so it is
 * a warning with the remaining DOF count. A trivial or absent solve is no mark.
 *
 * `nameFor`, when given, turns a mate id into its display label so the
 * overconstrained message names the mates the user sees.
 */
export function assemblyVerdict(
  status: AssemblySolveStatus | null,
  nameFor?: (id: string) => string | undefined,
): AssemblyMark & { verdict: string } {
  const verdict = status?.verdict ?? 'none'

  if (verdict === 'overconstrained') {
    // Name the mates that participated: every one that is not itself stale is
    // part of the conflict the user has to resolve.
    const ids = Object.keys(status?.mates ?? {}).filter(id => !status?.mates[id]?.stale)
    const names = ids.map(id => nameFor?.(id) ?? id)
    const which = names.length > 0 ? `: ${names.join(', ')}` : ''
    return {
      failed: true,
      level: 'error',
      message: `The mates cannot all be satisfied${which}.`,
      verdict,
      cause: 'error',
    }
  }
  if (verdict === 'not_converged') {
    return {
      failed: true,
      level: 'warning',
      message: 'The solver did not converge from the current seed; reseed a part or check flip.',
      verdict,
      cause: 'error',
    }
  }
  if (verdict === 'failed') {
    return {
      failed: true,
      level: 'error',
      message: status?.error || 'The mate solver failed.',
      verdict,
      cause: 'error',
    }
  }
  if (verdict === 'unavailable') {
    return {
      failed: true,
      level: 'error',
      message: status?.error || 'The mate solver is not available.',
      verdict,
      cause: 'error',
    }
  }
  if (verdict === 'underconstrained') {
    const dof = status?.dof ?? 0
    return {
      failed: false,
      level: 'warning',
      message: `Underconstrained: ${dof} degree${dof === 1 ? '' : 's'} of freedom.`,
      verdict,
    }
  }
  return { ...OK, verdict }
}
