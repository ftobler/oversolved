// Sketch-class geometry: a sketch and a helix are both authored reference
// geometry. They are drawn from the same render layers, hidden by the same
// rules and consumed the same way by the features built from them, so every
// site that asks "is this sketch geometry" must answer yes for both. A helix
// has no profile, but "sketch-class" is about how the editor treats the curve,
// not about what can be extruded.
//
// One predicate instead of a hand-rolled `|| kind === 'helix'` at each site:
// the visibility, consumption and look rules have to agree or a helix is
// half-hidden (say, gone from the tree but still drawn).
import type { HelixFeature, SketchFeature } from '@/types/cad'

export type SketchClassFeature = SketchFeature | HelixFeature

export function isSketchClassFeature(
  feature: { kind?: string } | null | undefined,
): feature is SketchClassFeature {
  return feature?.kind === 'sketch' || feature?.kind === 'helix'
}
