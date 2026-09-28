import type { PartFeature } from '@/types/cad'
import { findPlaneByQuery } from '@/pages/buildContextMenu'
import type { FaceFrame, NormalTarget } from '@/pages/buildContextMenu'

/**
 * Turn the normal selection into the one thing "Normal to" can aim at, or null.
 * Only a lone plane or a lone planar face has a single normal; two picks, an
 * edge, a vertex or a sketch entity name no view direction, so they yield null.
 *
 * `faceFrameFor` is the body-registry lookup (findFaceFrame) injected so this
 * stays a pure decision the tests drive without a mounted viewport. It answers
 * null for anything that is not a registered flat face, which is how edges and
 * curved faces drop out here. A face target keeps its query unchanged, since that
 * is what New Sketch hands the kernel as the sketch plane.
 */
export function resolveSelectionNormalTarget(
  selection: ReadonlySet<string>,
  selectedPicks: ReadonlyMap<string, ReadonlySet<string>>,
  features: PartFeature[],
  builtInIds: Set<string>,
  faceFrameFor: (query: string, pickKey: string | undefined) => FaceFrame | null,
): NormalTarget | null {
  if (selection.size !== 1) return null
  const [query] = selection

  const plane = findPlaneByQuery(query, features, builtInIds)
  if (plane) return { kind: 'plane', featureId: plane.id }

  // One claim names the exact face clicked. Several (a shared query clicked on
  // more than one sibling) or none (cleared by a re-solve) leave the query to
  // decide, as the highlight does.
  const picks = selectedPicks.get(query)
  const pickKey = picks?.size === 1 ? [...picks][0] : undefined
  const frame = faceFrameFor(query, pickKey)
  return frame ? { kind: 'face', query, normal: frame.normal, center: frame.center } : null
}
