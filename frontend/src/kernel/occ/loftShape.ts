// `applyLoftWithLineage`: the OCC adapter the loft leaf (features/loft.ts)
// calls to build a solid through a sequence of section wires
// (BRepOffsetAPI_ThruSections).
//
// Call shape and history are pinned by thruSectionsProbeReal.test.ts against
// the real OCCT 7.4.0p1 build:
//   - `new BRepOffsetAPI_ThruSections(isSolid, ruled, pres3d)` is the only bound
//     constructor (all three arguments) and `AddWire(wire)` takes no isClosing
//     flag.
//   - `Generated(edge)` returns the image of that edge in EVERY band it belongs
//     to: a middle section's edge reports both the band below and the band
//     above, so a band is reachable from either of its two sections. The lowest
//     section index that reaches a band therefore names it.
//   - `FirstShape()`/`LastShape()` hold the cap face of the first/last ADDED
//     wire (add order, never the world axis).
//   - Rules: 10x10 square to 6x6 square over 10 mm, ruled, is V = 653.33,
//     6 faces, 12 edges; three sections (10, 16, 8) smooth is V = 1918.7975,
//     6 faces; circle to square with CheckCompatibility(true) is 7 faces.
//
// Names are construction-based, never geometric: a side band mints
// `<createdBy>|loft|side|s<sectionIndex>|<entityId>`, a cap mints
// `<createdBy>|loft|cap|start`/`|end`. Geometry enters only the split ordering
// when one source edge yields several bands.

import { drainList, type DisposeScope } from './disposeScope'
import { extractErrorMessage } from '../errors'
import type { OccModule, OccShape } from './occTypes'
import type { PlaneLike } from '../features/shared/planes'
import type { LoopEdge } from '../profileLoops'
import { canonicalFaces } from './bodyNames'
import { SubShapeMap } from './subshapeIdentity'
import { faceCentroid } from './primitives'
import { entityForEdges } from './prismEdgeNaming'
import { mintFaceUuid, loftFacePath, splitFacePath, orderSplitChildren, type SplitChild } from '../constructionName'
import { builtFaceOf, type NewNames } from './edgeModifier'
import {
  nameNeighboursAndDeriveEdges,
  shapeNormalFrame,
  normalizedWorldKey,
  type NormalFrame,
} from './constructionLineage'
import { emitWire, absolute } from '../queryWire'

type Lineage = Record<string, string[]>

/** One loft section: a closed boundary wire in world space plus what names its
 *  edges. `loops`/`plane` are the sketch-side inputs `entityForEdges` matches
 *  the wire's edges against; `sketchId` scopes the side tokens and
 *  `profileQueries` is the cap's ancestry. A section resolved from a body face
 *  carries no sketch id and names no entity, so its bands fall to the
 *  neighbour pass. */
export interface LoftSection {
  wire: OccShape
  loops: LoopEdge[][]
  plane: PlaneLike
  sketchId: string
  profileQueries: string[]
}

export interface LoftBuildResult {
  shape: OccShape | null
  success: boolean
  reason: string | null
  names: NewNames | null
}

/** Reach used for the section-3d tolerance of the loft (the OCCT default). */
const LOFT_PRES3D = 1e-6

function fail(reason: string): LoftBuildResult {
  return { shape: null, success: false, reason, names: null }
}

/** The section wire's edges in explorer order (the order entityForEdges reads). */
function wireEdges(oc: OccModule, scope: DisposeScope, wire: OccShape): OccShape[] {
  const E = oc.TopAbs_ShapeEnum
  const out: OccShape[] = []
  const exp = scope.track(new oc.TopExp_Explorer_2(wire, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) {
    const raw = scope.track(exp.Current())
    out.push(scope.track(oc.TopoDS.Edge_1(raw)))
  }
  return out
}

/**
 * Loft through `sections` in order and return (shape + construction-name maps).
 * `ruled` picks straight bands between consecutive sections; otherwise one
 * smooth surface runs through every section. Lineage is tracked only when
 * `createdBy` is non-empty (the caller passes it when the body it builds
 * carries construction names). Failure returns `success: false` with the
 * reason; nothing was built, so the caller leaves the store alone. A successful
 * result's shape is DETACHED (the caller owns it), matching
 * `applyShellWithLineage`.
 */
export function applyLoftWithLineage(
  oc: OccModule,
  scope: DisposeScope,
  sections: LoftSection[],
  ruled: boolean,
  createdBy = '',
): LoftBuildResult {
  if (sections.length < 2) return fail('need at least two sections')
  let maker
  try {
    maker = scope.track(new oc.BRepOffsetAPI_ThruSections(true, ruled, LOFT_PRES3D))
    for (const section of sections) maker.AddWire(section.wire)
    maker.CheckCompatibility(true)
    if (!ruled) maker.SetSmoothing(true)
    maker.Build()
    if (!maker.IsDone()) return fail('build_not_done')
  } catch (e) {
    return fail(extractErrorMessage(e))
  }

  const built = scope.track(maker.Shape())
  const builtFaces = canonicalFaces(oc, scope, built) as OccShape[]
  const builtFace = builtFaceOf(builtFaces)
  const faceNames = new SubShapeMap<string>()
  const faceAncestry: Lineage = {}
  let frame: NormalFrame | null = null

  /** Name the images of one source in the built solid: one image keeps the base
   *  path, several become ordered split children. An image another source
   *  already claimed is left alone, which is what makes the lowest section
   *  index the naming one. */
  const assignImages = (images: OccShape[], base: string, ancestry: string[]): void => {
    if (images.length === 0) return
    const assign = (image: OccShape, uuid: string): void => {
      const key = builtFace(image)
      if (faceNames.has(key)) return
      faceNames.set(key, uuid)
      faceAncestry[uuid] = [...ancestry]
    }
    if (images.length === 1) {
      assign(images[0], base)
      return
    }
    frame ??= shapeNormalFrame(oc, scope, built)
    const f0 = frame
    const ordered = orderSplitChildren(
      images.map<SplitChild<OccShape>>((f) => ({
        item: f,
        key: normalizedWorldKey(f0, faceCentroid(oc, scope, f)),
      })),
    )
    if (ordered !== null) ordered.forEach((f, i) => assign(f, mintFaceUuid(splitFacePath(base, i))))
  }

  if (createdBy) {
    // Caps first: a cap is never reported by any section edge, but claiming
    // them first keeps the side pass structurally unable to shadow them.
    const caps: [('start' | 'end'), (() => OccShape), number][] = [
      ['start', () => maker.FirstShape(), 0],
      ['end', () => maker.LastShape(), sections.length - 1],
    ]
    for (const [which, get, at] of caps) {
      let images: OccShape[]
      try {
        images = canonicalFaces(oc, scope, get())
      } catch {
        continue
      }
      const section = sections[at]
      assignImages(images, mintFaceUuid(loftFacePath(createdBy, 'cap', which)), [...section.profileQueries])
    }

    // Bands: every section's edges in order. A generated image the caps or an
    // earlier section already named stays with that name.
    sections.forEach((section, index) => {
      const edges = wireEdges(oc, scope, section.wire)
      const eids = entityForEdges(oc, scope, edges, section.loops, section.plane)
      edges.forEach((edge, k) => {
        const eid = eids[k]
        if (!eid) return
        let images: OccShape[]
        try {
          images = drainList(scope, maker.Generated(edge)).flatMap((g) => canonicalFaces(oc, scope, g))
        } catch {
          return
        }
        const slot = `s${index}|${eid}`
        const ancestry = section.sketchId ? [emitWire(absolute(section.sketchId, eid))] : []
        assignImages(images, mintFaceUuid(loftFacePath(createdBy, 'side', slot)), ancestry)
      })
    })
  }

  // Whatever the history could not reach (a band between sections whose edges
  // vanished into the smooth surface, a face pick's section) is named off its
  // named neighbours, and the edges are derived from the face adjacency.
  const { edgeNames, edgeAncestry } = nameNeighboursAndDeriveEdges(oc, scope, built, faceNames, faceAncestry)
  const names: NewNames | null = createdBy
    ? { faceNames, edgeNames, faceAncestry, edgeAncestry }
    : null
  return { shape: scope.detach(built), success: true, reason: null, names }
}
