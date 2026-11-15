/**
 * The move-face rung ladder's labels and its runtime capability probes.
 *
 * Two rungs are OCCT features this pinned build does not bind:
 * GeomLib::ExtendSurfByLength (the native G1/G2 extension) and
 * BRepOffset_MakeOffset's per-face offset (the whole-route fallback). Both are
 * probed with `typeof` against the loaded module, never assumed from a string
 * in the wasm, so a pinned-release bump that adds either binding flips the rung
 * on and its `it.skipIf(!bound)` tests start running. Until then the rung is
 * skipped and every refusal that reaches it quotes `not bound in this OCCT
 * build`, which is the honest state of the feature.
 *
 * This module is only labels and probes: the extension code (moveFaceExtend.ts)
 * and the picked-face refusal (moveFaceSurfaces.ts) both quote it, and neither
 * may import the other.
 */

import type { OccModule } from './occTypes'

export const RUNG_1 = 'rung 1 (exact analytic extension)'
export const RUNG_2 = "rung 2 (widened UV patch on the face's own surface)"
export const RUNG_2_STRIP = 'rung 2b (G1 ruled continuation of the neighbour along the shared edge)'
export const RUNG_3 = 'rung 3 (GeomLib::ExtendSurfByLength)'
export const RUNG_4 = 'rung 4 (OCCT per-face offset)'
export const RUNG_T = 'rung T (tangent chain moved with the picked face)'

interface GeomLibLike {
  ExtendSurfByLength?: unknown
}

interface FaceOffsetLike {
  SetOffsetOnFace?: unknown
  MakeOffset?: unknown
}

/** Is GeomLib::ExtendSurfByLength bound in this OCCT build? */
export function rung3Bound(oc: OccModule): boolean {
  const lib = (oc as unknown as { GeomLib?: GeomLibLike }).GeomLib
  return typeof lib?.ExtendSurfByLength === 'function'
}

/** Is BRepOffset_MakeOffset (the per-face offset route) bound? */
export function rung4Bound(oc: OccModule): boolean {
  const algo = (oc as unknown as { BRepOffset_MakeOffset?: FaceOffsetLike }).BRepOffset_MakeOffset
  return typeof algo?.SetOffsetOnFace === 'function' && typeof algo?.MakeOffset === 'function'
}

/** The reason a rung did not run, for a refusal's rung list. */
export function unboundRungReason(oc: OccModule, rung: string): string {
  if (rung === RUNG_3) {
    if (!rung3Bound(oc)) return `${RUNG_3}: not bound in this OCCT build`
    return `${RUNG_3}: bound, but extending needs a copy of the face's Geom_Surface and this build exposes no surface copy`
  }
  if (rung === RUNG_4) {
    if (!rung4Bound(oc)) return `${RUNG_4}: not bound in this OCCT build`
    return `${RUNG_4}: bound, but the route has no Modified/Generated name transfer wired`
  }
  return `${rung}: not attempted`
}

/** The full rung list a refusal quotes, so the user sees every attempt. */
export function rungCatalog(oc: OccModule): string {
  return [
    `${RUNG_1}: exact for plane, cylinder, cone, sphere and torus; a freeform surface has no analytic primitive`,
    `${RUNG_2}: widens the face's own UV window; refused when the patch folds, loses the original boundary, or OCCT rejects the out-of-domain window`,
    `${RUNG_2_STRIP}: the ruled tangent continuation; first-order, so within O(d^2 / R) of the exact surface`,
    unboundRungReason(oc, RUNG_3),
    unboundRungReason(oc, RUNG_4),
    `${RUNG_T}: needs the tangent component moved as one set; not implemented for a single-face move`,
  ].join('; ')
}
