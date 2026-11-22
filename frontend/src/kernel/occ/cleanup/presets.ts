/**
 * The named plans a caller picks instead of listing passes.
 *
 * The per-feature decision what runs stays at the caller (`unifyFaces:
 * !part.imported && !skipFaceMerge(...)`, the coaxial-helix skip, the tolerance
 * inherited from the operands' sketches); the plan takes those as options and
 * does not re-derive them.
 *
 * The `before*` slots are the extension point for a pass added to an existing
 * flow, such as the seam re-seat, which must run after the cylinder pass chose
 * its final surfaces and before the merge folds the rim halves.
 */

import type { CleanupPlan, CleanupPlanEntry } from './types'
import type { CleanTolerances } from './unifySameDomain'
import { canonicalCylinders } from './canonicalCylinders'
import { unifySameDomain } from './unifySameDomain'

export interface BooleanPlanOptions {
  unifyFaces: boolean
  tolerance?: CleanTolerances
  /** Appended after canonicalisation and before the face merge. */
  beforeUnify?: readonly CleanupPlanEntry[]
}

/**
 * A boolean result: canonicalise cylindrical strips, then fold coincident
 * faces and split edges. `unifyFaces: false` is the imported-STEP gate and
 * keeps the edge merge only.
 */
export function booleanPlan(options: BooleanPlanOptions): CleanupPlan {
  return [
    { name: 'canonicalCylinders', pass: canonicalCylinders, selfGuarded: true },
    ...(options.beforeUnify ?? []),
    {
      name: 'unifySameDomain',
      pass: unifySameDomain,
      options: {
        unifyFaces: options.unifyFaces,
        linearTol: options.tolerance?.linearTol,
        angularTol: options.tolerance?.angularTol,
      },
      guard: {},
    },
  ]
}

export interface PrismPlanOptions {
  tolerance?: CleanTolerances
  /** Appended before the merge. */
  beforeUnify?: readonly CleanupPlanEntry[]
}

/** A fused prism profile: the merge alone, as prismLineage has always run it. */
export function prismPlan(options: PrismPlanOptions = {}): CleanupPlan {
  return [
    ...(options.beforeUnify ?? []),
    {
      name: 'unifySameDomain',
      pass: unifySameDomain,
      options: {
        unifyFaces: true,
        linearTol: options.tolerance?.linearTol,
        angularTol: options.tolerance?.angularTol,
      },
      guard: {},
    },
  ]
}
