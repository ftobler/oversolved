// @vitest-environment node
//
// prism-neighbour-naming: caps when the builder omits FirstShape/LastShape.
//
// The cap naming in buildPrismLineageMap depends on the builder reporting
// FirstShape()/LastShape() (optional in the builder type). A pipe shell that
// omits them leaves the caps unnamed, and each cap-lateral rim edge then
// degenerates to a seam-edge identity (single named face) that differs from a
// rebuild where the cap got named. The geometric fallback derives the caps from
// the profile face itself: a solid face that is a rigid translation of the
// profile (planar, parallel normal, equal area, centroid offset along the
// normal) is a cap, and the nearer/farther split is start/end. This file drives
// buildPrismLineageMap with a REAL pipe-shell solid whose builder stub reports
// no FirstShape/LastShape, and asserts the caps get the cap construction path
// (empty ancestry, the same as a builder-reported cap), every rim edge gets a
// unique construction UUID, and a rebuild mints the identical names.
//
// Skips when opencascade.js is absent.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { buildPrismLineageMap, sketchLoopsToFace, revolveFace } from '../prismLineage'
import { makeLineEdge, makeArcEdge, makeWire, healWire } from '../primitives'
import type { PlaneLike } from '../../features/shared/planes'
import type { LoopEdge } from '../../profileLoops'
import type { OccModule, OccShape, OccListOfShape } from '../occTypes'

const oc = await loadOcc()

describe.skipIf(!oc)('prism caps with a builder that omits FirstShape/LastShape (real OCC)', () => {
  it('caps and rim edges are named from the profile geometry and survive a rebuild', () => {
    const scope = new DisposeScope()
    try {
      const occ = oc as OccModule
      const planeXY: PlaneLike = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
      const square: LoopEdge[][] = [[
        { kind: 'line', start: [-2, -2], end: [2, -2], id: 'b' },
        { kind: 'line', start: [2, -2], end: [2, 2], id: 'r' },
        { kind: 'line', start: [2, 2], end: [-2, 2], id: 't' },
        { kind: 'line', start: [-2, 2], end: [-2, -2], id: 'l' },
      ]]
      const face = sketchLoopsToFace(occ, scope, square, planeXY)
      const spineEdges = [makeLineEdge(occ, scope, [0, 0, 0], [0, 0, 3])]
      const spineWire = healWire(occ, scope, makeWire(occ, scope, spineEdges))
      const outerWire = scope.track(healWire(occ, scope, scope.track(occ.BRepTools.OuterWire(face))))

      const build = (): {
        faces: Record<string, string>
        edges: Record<string, string>
        ancestry: Record<string, string[]>
      } => {
        const builder = scope.track(new occ.BRepOffsetAPI_MakePipeShell(spineWire))
        builder.SetTransitionMode(occ.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner)
        builder.Add_1(outerWire, false, false)
        builder.Build()
        if (!builder.IsDone() || !builder.MakeSolid()) throw new Error('probe pipe shell failed')
        // The stub reports NO FirstShape/LastShape on purpose.
        const stub = {
          Shape: (): OccShape => builder.Shape(),
          Generated: (s: OccShape): OccListOfShape => builder.Generated(s),
        }
        const maps = buildPrismLineageMap(occ, scope, face, stub, square, planeXY, 'feat', 'sk1')
        return { faces: { ...maps.faceNames }, edges: { ...maps.edgeNames }, ancestry: { ...maps.faceAncestry } }
      }

      const first = build()
      const second = build()

      // Six faces: 4 lateral (named from Generated side edges) + 2 caps (named
      // from the geometric fallback). Zero faces left unnamed.
      expect(Object.keys(first.faces).length).toBe(6)

      // The caps went through the cap construction path: their ancestry is
      // EMPTY (a cap carries no profile token), exactly like a builder-reported
      // cap. A neighbour-corner name would inherit the lateral faces' tokens.
      expect(Object.values(first.ancestry).filter((tokens) => tokens.length === 0).length).toBe(2)

      // Every rim edge (cap-lateral pair) and every lateral-lateral edge earns
      // a unique construction UUID: 12 edges on a 2x2 square swept 3 units.
      expect(Object.keys(first.edges).length).toBe(12)
      const edgeUuids = Object.values(first.edges)
      expect(new Set(edgeUuids).size).toBe(12)
      for (const u of edgeUuids) expect(u.startsWith('e_')).toBe(true)

      // The names are deterministic across a rebuild (the symbolic cap path and
      // the face-pair edge derivation recompute to the same values).
      expect(second).toEqual(first)
    } finally {
      scope.dispose()
    }
  })

  it('loudly refuses a builder that generated no face for any profile edge (total lineage miss)', () => {
    const scope = new DisposeScope()
    try {
      const occ = oc as OccModule
      const planeXY: PlaneLike = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
      const rect: LoopEdge[][] = [[
        { kind: 'line', start: [2, 0], end: [5, 0], id: 'e1' },
        { kind: 'line', start: [5, 0], end: [5, 4], id: 'e2' },
        { kind: 'line', start: [5, 4], end: [2, 4], id: 'e3' },
        { kind: 'line', start: [2, 4], end: [2, 0], id: 'e4' },
      ]]
      const face = sketchLoopsToFace(occ, scope, rect, planeXY)
      const solid = revolveFace(occ, scope, face, [0, 0, 0], [0, 1, 0], 90)
      const emptyList = scope.track(new occ.TopTools_ListOfShape_1())
      // A builder that reports no generated side faces: every profile edge maps
      // to an entity but none of them produced a face, so the M11 guard fires
      // by name instead of every edge limping to the old unrescued-topology
      // diagnostic.
      const stub = {
        Shape: (): OccShape => solid,
        Generated: (): OccListOfShape => emptyList,
      }
      expect(() => buildPrismLineageMap(occ, scope, face, stub, rect, planeXY, 'feat', 'sk1')).toThrow(
        /generated no face for any profile edge/,
      )
    } finally {
      scope.dispose()
    }
  })

  it('a cap-role face the cap path cannot reach stays unnamed (byte-identical to the old wire)', () => {
    const scope = new DisposeScope()
    try {
      const occ = oc as OccModule
      const planeXY: PlaneLike = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
      const square: LoopEdge[][] = [[
        { kind: 'line', start: [-2, -2], end: [2, -2], id: 'b' },
        { kind: 'line', start: [2, -2], end: [2, 2], id: 'r' },
        { kind: 'line', start: [2, 2], end: [-2, 2], id: 't' },
        { kind: 'line', start: [-2, 2], end: [-2, -2], id: 'l' },
      ]]
      const face = sketchLoopsToFace(occ, scope, square, planeXY)
      const outerWire = scope.track(healWire(occ, scope, scope.track(occ.BRepTools.OuterWire(face))))
      // An ARC spine rotates the profile, so the end cap is NOT a translation
      // of it: the geometric probe cannot name it, and the cap-role gate keeps
      // the neighbour pass from reclassifying it as a corner face.
      const arcSpine = [makeArcEdge(occ, scope, [10, 0, 0], [0, -1, 0], [0, 0, -1], 10, 0, Math.PI / 2)]
      const spineWire = healWire(occ, scope, makeWire(occ, scope, arcSpine))
      const builder = scope.track(new occ.BRepOffsetAPI_MakePipeShell(spineWire))
      builder.SetTransitionMode(occ.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner)
      builder.Add_1(outerWire, false, false)
      builder.Build()
      if (!builder.IsDone() || !builder.MakeSolid()) throw new Error('probe pipe shell failed')
      const stub = {
        Shape: (): OccShape => builder.Shape(),
        Generated: (s: OccShape): OccListOfShape => builder.Generated(s),
      }
      const maps = buildPrismLineageMap(occ, scope, face, stub, square, planeXY, 'feat', 'sk1')

      // The 4 generated lateral faces plus the end cap (which the M7 fix no
      // longer classifies as a cap-role face because it is rotated by the arc
      // spine) are named.  The start cap (parallel to the profile) stays
      // absent from faceNames AND faceAncestry.
      expect(Object.keys(maps.faceNames).length).toBe(5)
      expect(Object.keys(maps.faceAncestry).length).toBe(5)
      // Every rim edge still resolves as a single-face seam (its cap is
      // unnamed, exactly the old wire), and the lateral-lateral edges as pairs.
      expect(Object.keys(maps.edgeNames).length).toBe(12)
    } finally {
      scope.dispose()
    }
  })
})
