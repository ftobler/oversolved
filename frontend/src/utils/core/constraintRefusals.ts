// The one wording for an authoring refusal caused by redundancy. Shared by the
// placement gate, the command door and the driven toggle, so a user sees the
// same sentence whichever path tried to add the driving row.
import { CONSTRAINT_BY_KIND } from '@/registry/constraintRegistry'

export function overconstrainReason(kind: string): string {
  const label = CONSTRAINT_BY_KIND.get(kind)?.label ?? kind
  return `This would overconstrain the sketch: the ${label.toLowerCase()} is already implied by the existing constraints.`
}

export const DRIVEN_LOCK_HINT = 'Already set by the existing constraints; this dimension can only measure.'
