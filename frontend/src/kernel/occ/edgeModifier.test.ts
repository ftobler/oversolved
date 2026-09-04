// Unit test for the L16 merge-collision refusal in edgeModifier.extractNames.
//
// Two old NAMED faces that both Modified() to the same new face (a blend
// absorbing a sliver) must not silently drop one UUID: the second write would
// overwrite the first, and which one survives would be topology order, not
// construction order. The fix drops both and lets nameFacesFromNeighbours mint
// a name from the surviving neighbourhood; a third face that also modifies to
// the same output must not re-claim the cancelled key.
//
// extractNames is driven with a fake OCC module and a maker double whose
// Modified() returns the same face for every input, so no opencascade.js is
// needed.

import { describe, it, expect } from 'vitest'
import { DisposeScope } from './disposeScope'
import { extractNames, type NewNames, type OldNames } from './edgeModifier'
import { faceGh } from './lineageHash'
import type { OccModule, OccShape, OccEdgeModifierMaker } from './occTypes'

type Vec3 = [number, number, number]

const pnt = (v: Vec3) => ({
  X: () => v[0],
  Y: () => v[1],
  Z: () => v[2],
  delete: () => {},
})

// A face double carrying the geometry faceCentroid/faceNormal read, plus the
// topological identity builtGh needs (identity IsSame: each face is its own
// built-solid twin).
function makeFace(centroid: Vec3, normal: Vec3): OccShape {
  const face = {
    centroid,
    normal,
    IsSame: (other: unknown): boolean => other === face,
    Orientation_1: () => ({ value: 0 }),  // FORWARD
    delete: () => {},
  }
  return face as unknown as OccShape
}

// The minimal OCC surface extractNames touches: shape explorer, face casts,
// centroid props and surface-normal props. New shapes hold `faces`; faces hold
// `edges` (empty here: the merged face is left unnamed, so no edge geometry is
// ever read).
function makeOcc(): OccModule {
  const E = {
    TopAbs_VERTEX: { value: 0 },
    TopAbs_EDGE: { value: 1 },
    TopAbs_FACE: { value: 3 },
    TopAbs_SHAPE: { value: 8 },
  }
  return {
    TopAbs_ShapeEnum: E,
    TopAbs_Orientation: { TopAbs_FORWARD: { value: 0 }, TopAbs_REVERSED: { value: 1 } },
    TopoDS: {
      Face_1: (s: OccShape) => s,
      Edge_1: (s: OccShape) => s,
    },
    TopExp_Explorer_2: function (shape: OccShape, kind: object) {
      const holder = shape as unknown as { faces?: OccShape[]; edges?: OccShape[] }
      const items = kind === E.TopAbs_FACE ? holder.faces ?? [] : holder.edges ?? []
      let i = 0
      return {
        More: () => i < items.length,
        Next: () => {
          i++
        },
        Current: () => items[i],
        delete: () => {},
      }
    },
    GProp_GProps_1: function () {
      return {
        centroid: [0, 0, 0] as Vec3,
        CentreOfMass: function () {
          return pnt(this.centroid)
        },
        delete: () => {},
      }
    },
    BRepGProp: {
      SurfaceProperties_1: (face: OccShape, props: { centroid: Vec3 }) => {
        props.centroid = (face as unknown as { centroid: Vec3 }).centroid
      },
    },
    BRepAdaptor_Surface_2: function (face: OccShape) {
      return {
        face,
        FirstUParameter: () => 0,
        LastUParameter: () => 1,
        FirstVParameter: () => 0,
        LastVParameter: () => 1,
        delete: () => {},
      }
    },
    BRepLProp_SLProps_1: function (adaptor: { face: OccShape }) {
      return {
        IsNormalDefined: () => true,
        Normal: () => pnt((adaptor.face as unknown as { normal: Vec3 }).normal),
        delete: () => {},
      }
    },
  } as unknown as OccModule
}

// A maker double: every named old face reports Modified() to the single merged
// output, the blend-absorbs-a-sliver shape the L16 fix is about.
function makeMaker(merged: OccShape): OccEdgeModifierMaker {
  return {
    IsDeleted: () => false,
    Modified: () => ({
      Size: () => 1,
      First_1: () => merged,
      RemoveFirst: () => {},
      delete: () => {},
    }),
    Generated: () => ({ Size: () => 0, delete: () => {} }),
    Add_2: () => {},
    AddDA: () => {},
    Build: () => {},
    IsDone: () => true,
    Shape: () => merged,
    delete: () => {},
  } as unknown as OccEdgeModifierMaker
}

// Name `uuids[i]` on old face i, then run the name transfer into a new shape
// that holds only `newFace`.
function run(oldFaces: OccShape[], newFace: OccShape, uuids: string[]): NewNames {
  const oc = makeOcc()
  const scope = new DisposeScope()
  const old: OldNames = {
    createdBy: 'fillet1',
    faceNames: {},
    edgeNames: {},
    faceAncestry: {},
    edgeAncestry: {},
  }
  oldFaces.forEach((f, i) => {
    old.faceNames[faceGh(oc, scope, f)] = uuids[i]
    old.faceAncestry[uuids[i]] = ['extrude1']
  })
  return extractNames(
    oc,
    scope,
    makeMaker(newFace),
    { faces: oldFaces } as unknown as OccShape,
    { faces: [newFace] } as unknown as OccShape,
    [],
    old,
  )
}

describe('extractNames face-merge collision', () => {
  it('assigns the name when one face modifies to one output', () => {
    const merged = makeFace([0, 0, 0], [0, 0, 1])
    const res = run([makeFace([-1, -1, 0], [0, 0, 1])], merged, ['uuid_A'])
    const key = faceGh(makeOcc(), new DisposeScope(), merged)
    expect(res.faceNames[key]).toBe('uuid_A')
    expect(res.faceAncestry['uuid_A']).toEqual(['extrude1'])
  })

  it('drops both names when two named faces merge into one', () => {
    const merged = makeFace([0, 0, 0], [0, 0, 1])
    const res = run(
      [makeFace([-1, -1, 0], [0, 0, 1]), makeFace([1, 1, 0], [0, 0, 1])],
      merged,
      ['uuid_A', 'uuid_B'],
    )
    expect(Object.keys(res.faceNames)).toHaveLength(0)
    expect(Object.keys(res.faceAncestry)).toHaveLength(0)
  })

  it('lets no third face re-claim a key the collision already cancelled', () => {
    const merged = makeFace([0, 0, 0], [0, 0, 1])
    const res = run(
      [
        makeFace([-1, -1, 0], [0, 0, 1]),
        makeFace([1, 1, 0], [0, 0, 1]),
        makeFace([0, 2, 0], [0, 0, 1]),
      ],
      merged,
      ['uuid_A', 'uuid_B', 'uuid_C'],
    )
    const key = faceGh(makeOcc(), new DisposeScope(), merged)
    expect(res.faceNames[key]).toBeUndefined()
    expect(res.faceAncestry['uuid_C']).toBeUndefined()
    expect(Object.keys(res.faceNames)).toHaveLength(0)
  })
})