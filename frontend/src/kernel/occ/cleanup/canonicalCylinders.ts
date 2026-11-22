/**
 * The cylinder canonicalisation as a cleanup pass.
 *
 * The recognition and rebuild stay in `canonicalSurfaces.ts`; this adapter is
 * the layer's entry to it. The pass carries its own guard internally (a
 * refused rebuild returns its input), which the plan declares `selfGuarded` so
 * the layer does not pay a second whole-shape check on geometry the pass did
 * not build.
 */

import type { DisposeScope } from '../disposeScope'
import type { PassResult } from './types'
import type { OccModule, OccShape } from '../occTypes'
import { canonicalizeCylinderFaces } from '../canonicalSurfaces'

export function canonicalCylinders(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
): PassResult {
  const canonical = canonicalizeCylinderFaces(oc, scope, shape)
  return { shape: canonical.shape, changed: canonical.changed, rebase: canonical.rebase }
}
