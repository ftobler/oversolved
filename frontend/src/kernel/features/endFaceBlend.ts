// The safe prism-cut fallback for a fillet/chamfer the rolling-ball builder
// refused on a small END face (plan bug-fillet-end-cap-sliver).
//
// The policy is here, the geometry in occ/cornerBlend.ts. An edge qualifies
// only when the prism is exactly what a rolling-ball blend would produce: a
// straight edge between two planes (a constant cross-section), no tangent-chain
// neighbours (so OCC's propagation semantics are unchanged), every other face
// at both ends planar and square to the edge (a blend ends flat on such a cap),
// and a consumed end face (the cause this fallback exists for, not a general
// retry).
//
// Naming is the hard part and is what makes the two builders interchangeable: a
// rolling-ball fillet mints one UUID per blend face from the picked edge
// (`filletFacePath`). The prism's blend face carries the same symbolic name, so
// it gets the SAME UUID, and inherited faces come through the boolean's
// Modified history exactly like a hand-authored cut. A fully consumed end face
// has no image, which is the honest record: it is gone.
//
// The modifier's `EdgeFallback` contract is what the leaf hands it; the factories
// at the bottom build one per blend spec.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape } from '../occ/occTypes'
import { canonicalVertices } from '../occ/bodyNames'
import { SubShapeMap } from '../occ/subshapeIdentity'
import { booleanWithDiff, type FaceOrigin } from '../occ/booleans'
import {
  consumedEndFace,
  cornerFit,
  facesAtVertex,
  makeCornerTool,
  planarFaceNormal,
  SQUARE_ANGULAR_TOL,
  type CornerBlendSpec,
  type CornerFit,
} from '../occ/cornerBlend'
import type { EdgeFallback, NewNames } from '../occ/edgeModifier'
import { filletFacePath, mintFaceUuid } from '../constructionName'
import { faceWidthAcrossEdge } from './edgeFailureDiagnosis'
import { transferBooleanNames } from './booleanLineage'
import { tangentChain } from './tangentChain'
import { swallowUnlessTrap } from '../errors'

function fallback(blend: CornerBlendSpec, createdBy: string): EdgeFallback {
  return {
    qualifies(oc, scope, shape, edge) {
      try {
        const fit = cornerFit(oc, scope, shape, edge, blend)
        if (fit === null) return false
        // OCC continues a blend across a G1 joint; a prism stops at the edge, so
        // a chain would build something the maker would not have.
        if (tangentChain(oc, shape, [edge]).chain !== 1) return false
        if (!squareCaps(oc, scope, shape, edge, fit)) return false
        if (!blendFitsFaces(oc, scope, edge, fit)) return false
        return consumedEndFace(oc, scope, shape, edge, blend, fit) !== null
      } catch (e) {
        swallowUnlessTrap(e)
        return false
      }
    },
    build(oc, scope, shape, edge, names) {
      let cutShape: OccShape | null = null
      try {
        const fit = cornerFit(oc, scope, shape, edge, blend)
        if (fit === null) return null
        // Without a construction UUID for the picked edge the maker would have
        // left the blend unnamed too, so the fallback cannot keep identity. A
        // body that carries no names at all still builds; the cut is just
        // unnamed like any other lineage-free modifier result.
        const edgeUuid = names?.edgeNames.get(edge as OccSubShape)
        if (names !== null && edgeUuid === undefined) return null
        const tool = makeCornerTool(oc, scope, fit, blend)
        if (tool === null) return null
        const blendUuid = edgeUuid === undefined ? null : mintFaceUuid(filletFacePath(createdBy, edgeUuid))
        const cut = booleanWithDiff(oc, scope, shape, tool.shape, 'cut')
        cutShape = cut.shape
        const carried = names === null || blendUuid === null
          ? null
          : carryNames(oc, scope, cut, names, { blendUuid, blendFace: tool.blendFace, createdBy, edgeUuid: edgeUuid as string })
        if (names !== null && carried === null) {
          // A cut that lost the blend's name would leave every pick on it to the
          // ancestral fallback, so it is refused rather than shipped unnamed.
          scope.release(cutShape)
          return null
        }
        // The cut shape is untracked on purpose: the modifier owns the result and
        // hands it out as the new body.
        return { shape: cut.shape, names: carried, diff: cut.diff }
      } catch (e) {
        swallowUnlessTrap(e)
        if (cutShape !== null) scope.release(cutShape)
        return null
      }
    },
  }
}

/** A fillet prism cut for `radius`, minting blend names under `createdBy`. */
export function makeFilletPrismFallback(radius: number, createdBy: string): EdgeFallback {
  return fallback({ kind: 'fillet', radius }, createdBy)
}

/** A distance chamfer prism cut. An angle-distance chamfer is not offered: its
 *  second leg depends on the reference face and the angle, and a wrong-angle
 *  bevel is worse than the refusal. */
export function makeChamferPrismFallback(distance: number, createdBy: string): EdgeFallback {
  return fallback({ kind: 'chamfer', distance }, createdBy)
}

// On in production. The diagnosis tests turn it off so the refusal path keeps
// a user-visible message: with the fallback available the same pick builds, and
// the wording that explains a consumed end face would never be produced.
let prismEnabled = true

/** Test-only: whether the leaves offer the prism fallback. */
export function setEndFacePrismEnabledForTest(enabled: boolean): void {
  prismEnabled = enabled
}

/** Whether the leaves should offer the prism fallback (production: always). */
export function endFacePrismEnabled(): boolean {
  return prismEnabled
}

/**
 * Both ends of the edge must meet planar caps square to it, with no other face
 * at the vertex leaning off square: the prism ends flush there, while a
 * rolling-ball blend can stop on a slanted or curved face in a way the prism
 * cannot reproduce.
 */
function squareCaps(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  edge: OccShape,
  fit: CornerFit,
): boolean {
  for (const vertex of canonicalVertices(oc, scope, edge) as OccShape[]) {
    for (const face of facesAtVertex(oc, scope, shape, vertex)) {
      if (fit.faces.some((adjacent) => (adjacent as OccSubShape).IsSame(face as OccSubShape))) continue
      const n = planarFaceNormal(oc, scope, face)
      if (n === null) return false
      const cos = Math.abs(n[0] * fit.direction[0] + n[1] * fit.direction[1] + n[2] * fit.direction[2])
      if (cos < Math.cos(SQUARE_ANGULAR_TOL)) return false
    }
  }
  return true
}

/**
 * The blend has to fit the two faces it sits on. If the setback runs past a
 * face's width, the maker refused because the value is too big for that face
 * (the width diagnosis says so) and not because an end face is consumed; a tiny
 * box would otherwise be "rounded" into a sliver. This is the same measurement
 * the width diagnosis reports, so the two never disagree about which case a
 * refusal is.
 */
function blendFitsFaces(oc: OccModule, scope: DisposeScope, edge: OccShape, fit: CornerFit): boolean {
  return fit.faces.every((face, i) => {
    const width = faceWidthAcrossEdge(oc, scope, edge, face)
    if (width === null) return false
    return fit.setbacks[i] < width - 1e-9 * Math.max(1, width)
  })
}

/** Move the pre-cut names onto the cut result, with the blend face named as the
 *  maker would name it. Null when the blend face did not take its name: an
 *  unnamed blend would leave every pick on it to the ancestral fallback. */
function carryNames(
  oc: OccModule,
  scope: DisposeScope,
  cut: { shape: OccShape; faceOrigin: FaceOrigin[] },
  names: NewNames,
  blend: { blendUuid: string; blendFace: OccShape; createdBy: string; edgeUuid: string },
): NewNames | null {
  const toolFaceNames = new SubShapeMap<string>()
  toolFaceNames.set(blend.blendFace as OccSubShape, blend.blendUuid)
  const carried = transferBooleanNames(oc, scope, {
    bodyShape: cut.shape,
    faceOrigin: cut.faceOrigin,
    targetFaceNames: names.faceNames,
    targetFaceAncestry: names.faceAncestry,
    targetCapAncestry: names.capAncestry,
    targetFaceOwner: names.faceOwner,
    targetEdgeOwner: names.edgeOwner,
    toolFaceNames,
    toolFaceAncestry: { [blend.blendUuid]: names.edgeAncestry[blend.edgeUuid] ?? [] },
    toolFaceOwner: { [blend.blendUuid]: blend.createdBy },
    toolCreatedBy: blend.createdBy,
    toolUuidScope: null,
  })
  let named = false
  for (const [, uuid] of carried.faceNames.entries()) {
    if (uuid === blend.blendUuid) {
      named = true
      break
    }
  }
  return named ? carried : null
}
