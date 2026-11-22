/**
 * The named plans a caller picks instead of listing passes.
 *
 * The per-feature decision what runs stays at the caller (`unifyFaces:
 * !part.imported && !skipFaceMerge(...)`, the coaxial-helix skip, the tolerance
 * inherited from the operands' sketches); the plan takes those as options and
 * does not re-derive them.
 *
 * The `before*` slots are the extension point for a pass added to an existing
 * flow. The residual-seam re-seat is not a slot user: it is built into both
 * plans, after the cylinder pass chose its final surfaces (and after a
 * modifier's heal) and before the merge folds the rim halves it releases.
 */

import type { CleanupPlan, CleanupPlanEntry } from './types'
import type { CleanTolerances } from './unifySameDomain'
import { canonicalCylinders } from './canonicalCylinders'
import { heal } from './heal'
import { reseatSeams } from './reseatSeams'
import { unifySameDomain } from './unifySameDomain'

/**
 * The residual-seam re-seat: always its own guard option (a rebuilt face must
 * validate even on an open shell, the same demand the cylinder rebuild makes).
 * It sits before every merge so the merge folds the rim halves it releases.
 */
function reseatEntry(): CleanupPlanEntry {
  return { name: 'reseatSeams', pass: reseatSeams, guard: { validity: 'always' } }
}

export interface BooleanPlanOptions {
  unifyFaces: boolean
  tolerance?: CleanTolerances
  // Appended after canonicalisation and before the seam re-seat.
  beforeUnify?: readonly CleanupPlanEntry[]
}

/**
 * A boolean result: canonicalise cylindrical strips, re-seat a seam that a
 * feature rim cut, then fold coincident faces and split edges. `unifyFaces:
 * false` is the imported-STEP gate and keeps the edge merge only.
 */
export function booleanPlan(options: BooleanPlanOptions): CleanupPlan {
  return [
    { name: 'canonicalCylinders', pass: canonicalCylinders, selfGuarded: true },
    ...(options.beforeUnify ?? []),
    reseatEntry(),
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
  // Appended before the merge.
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

/**
 * How a modifier plan treats the healer. `whenInvalid` is the plan's own
 * validity gate; `required` and `skip` are for a caller that already ran that
 * gate on this exact build, so the layer does not pay a second whole-shape
 * check only to throw its answer away.
 */
export type HealMode = 'whenInvalid' | 'required' | 'skip'

export interface ModifierPlanOptions {
  heal?: HealMode
  // Admit a mixed-orientation invalid input (a fillet whose new face flipped).
  // Off for a shell, whose positive-volume corruption must be refused.
  allowMixedOrientation?: boolean
  // Appended after the heal and before the seam re-seat.
  beforeMerge?: readonly CleanupPlanEntry[]
}

/**
 * A fillet, chamfer, shell or defeature result: heal when invalid, re-seat a
 * seam the modifier's own result carries, then merge edges only. The face
 * merge stays off so a feature's own face is never folded into a neighbour and
 * stored face UUIDs do not churn; the edge merge is the same always-safe call
 * the imported-STEP boolean path keeps.
 */
export function modifierPlan(options: ModifierPlanOptions = {}): CleanupPlan {
  const mode = options.heal ?? 'whenInvalid'
  const plan: CleanupPlanEntry[] = []
  if (mode !== 'skip') {
    plan.push({
      name: 'heal',
      pass: heal,
      options: {
        onlyIfInvalid: mode === 'whenInvalid',
        allowMixedOrientation: options.allowMixedOrientation === true,
      },
      selfGuarded: true,
    })
  }
  plan.push(...(options.beforeMerge ?? []))
  plan.push(reseatEntry())
  plan.push({
    name: 'unifySameDomain',
    pass: unifySameDomain,
    options: { unifyFaces: false },
    guard: {},
  })
  return plan
}
