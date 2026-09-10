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

export interface StatusMark {
  failed: boolean
  level: 'error' | 'warning' | null
  message: string
}

const OK: StatusMark = { failed: false, level: null, message: '' }

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
): StatusMark {
  const result = status?.mates[id]
  if (!result) return OK

  if (result.error) return { failed: true, level: 'error', message: result.error }

  const refPartFailed = refParts?.some(part => partFailure(part, status).failed)
  if (refPartFailed) {
    return { failed: true, level: 'error', message: 'The referenced part failed to load.' }
  }

  if (result.stale) {
    return { failed: true, level: 'error', message: 'A reference no longer resolves; re-pick it.' }
  }
  return OK
}

/**
 * Whether part instance `handle` failed to load. Absent means healthy: only a
 * bundle that failed records an entry.
 */
export function partFailure(handle: string, status: AssemblySolveStatus | null): StatusMark {
  const result = status?.parts[handle]
  if (!result?.failed) return OK
  return { failed: true, level: 'error', message: result.error || 'The part failed to load.' }
}

/**
 * The overall solve verdict as one mark for the assembly root row and banner.
 *
 * Overconstrained, failed and unavailable are hard errors. Underconstrained is
 * informational -- the assembly is valid, it just still has freedom -- so it is
 * a warning with the remaining DOF count. A trivial or absent solve is no mark.
 */
export function assemblyVerdict(
  status: AssemblySolveStatus | null,
): StatusMark & { verdict: string } {
  const verdict = status?.verdict ?? 'none'

  if (verdict === 'overconstrained') {
    // Name the mates that participated: every one that is not itself stale is
    // part of the conflict the user has to resolve.
    const ids = Object.keys(status?.mates ?? {}).filter(id => !status?.mates[id]?.stale)
    const which = ids.length > 0 ? ` (${ids.join(', ')})` : ''
    return {
      failed: true,
      level: 'error',
      message: `The mates cannot all be satisfied: overconstrained${which}.`,
      verdict,
    }
  }
  if (verdict === 'failed') {
    return {
      failed: true,
      level: 'error',
      message: status?.error || 'The mate solver failed.',
      verdict,
    }
  }
  if (verdict === 'unavailable') {
    return {
      failed: true,
      level: 'error',
      message: status?.error || 'The mate solver is not available.',
      verdict,
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
