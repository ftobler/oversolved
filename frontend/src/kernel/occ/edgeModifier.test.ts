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
import { DisposeScope, drainList } from './disposeScope'
import { extractNames, applyChamferWithDiff, type NewNames, type OldNames } from './edgeModifier'
import { emptyBrepDiff } from '../types3d'
import { mintFaceUuid, splitFacePath, filletFacePath } from '../constructionName'
import { faceGh, edgeGh } from './lineageHash'
import { SubShapeIndexMap } from './primitives'
import type { OccModule, OccShape, OccSubShape, OccEdgeModifierMaker } from './occTypes'

type Vec3 = [number, number, number]

const pnt = (v: Vec3) => ({
  X: () => v[0],
  Y: () => v[1],
  Z: () => v[2],
  delete: () => {},
})

// A face double carrying the geometry faceCentroid/faceNormal read, plus the
// topological identity builtGh needs (identity IsSame: each face is its own
// built-solid twin). A constant HashCode forces every face into one
// SubShapeIndexMap bucket, which the IsSame confirm then splits apart.
function makeFace(centroid: Vec3, normal: Vec3, area = 4): OccShape {
  const face = {
    centroid,
    normal,
    area,
    IsSame: (other: unknown): boolean => other === face,
    HashCode: () => 1,
    Orientation_1: () => ({ value: 0 }),  // FORWARD
    delete: () => {},
  }
  return face as unknown as OccShape
}

// A straight-edge double: edgeToGeom reads the curve adaptor's type and its
// two endpoint values, so a line needs nothing but start/end and identity.
function makeLineEdge(start: Vec3, end: Vec3): OccShape {
  const edge = {
    start,
    end,
    IsSame: (other: unknown): boolean => other === edge,
    HashCode: () => 1,
    delete: () => {},
  }
  return edge as unknown as OccShape
}

// A TopTools_ListOfShape double. drainList reads Size once, then First_1 +
// RemoveFirst per element, so the head must advance under RemoveFirst.
function makeList(items: OccShape[]): {
  Size: () => number
  First_1: () => OccShape
  RemoveFirst: () => void
  delete: () => void
} {
  let i = 0
  return {
    Size: () => items.length - i,
    First_1: () => items[i],
    RemoveFirst: () => {
      i++
    },
    delete: () => {},
  }
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
        area: 1,
        CentreOfMass: function () {
          return pnt(this.centroid)
        },
        Mass: function () {
          return this.area
        },
        delete: () => {},
      }
    },
    BRepGProp: {
      SurfaceProperties_1: (face: OccShape, props: { centroid: Vec3; area: number }) => {
        const f = face as unknown as { centroid: Vec3; area?: number }
        props.centroid = f.centroid
        props.area = f.area ?? 1
      },
    },
    GeomAbs_CurveType: { GeomAbs_Line: { value: 0 }, GeomAbs_Circle: { value: 1 } },
    BRepAdaptor_Curve_2: function (edge: OccShape) {
      const e = edge as unknown as { start: Vec3; end: Vec3 }
      return {
        GetType: () => ({ value: 0 }),  // GeomAbs_Line
        FirstParameter: () => 0,
        LastParameter: () => 1,
        Value: (u: number) => pnt(u < 0.5 ? e.start : e.end),
        delete: () => {},
      }
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
function run(oldFaces: OccShape[], newFace: OccShape, uuids: string[], maker = makeMaker(newFace)): NewNames {
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
  // Mirror applyEdgeModifier's shared Modified() drain: one drain per old face,
  // keyed through a SubShapeIndexMap.
  const oldFaceIdx = new SubShapeIndexMap()
  oldFaces.forEach((f, i) => oldFaceIdx.set(f as OccSubShape, i))
  const oldFaceModified = new Map<number, OccShape[]>()
  for (const f of oldFaces) {
    oldFaceModified.set(oldFaceIdx.get(f as OccSubShape), drainList(scope, maker.Modified(f)))
  }
  return extractNames(
    oc,
    scope,
    maker,
    { faces: [newFace] } as unknown as OccShape,
    [],
    old,
    oldFaces,
    [newFace],
    oldFaceIdx,
    oldFaceModified,
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

  it('keeps a named face when the IsDeleted probe throws', () => {
    // A throwing history probe is not evidence of deletion: treating the throw
    // as "deleted" would silently drop the face's construction UUID and evict
    // every pick stored against it.
    const merged = makeFace([0, 0, 0], [0, 0, 1])
    const maker = makeMaker(merged)
    ;(maker as unknown as { IsDeleted: () => boolean }).IsDeleted = () => {
      throw new Error('history unavailable')
    }
    const res = run([makeFace([-1, -1, 0], [0, 0, 1])], merged, ['uuid_A'], maker)
    const key = faceGh(makeOcc(), new DisposeScope(), merged)
    expect(res.faceNames[key]).toBe('uuid_A')
    expect(res.faceAncestry['uuid_A']).toEqual(['extrude1'])
  })
})

// Build an OldNames map keyed on the faces/edges the caller names, and run the
// name transfer. `newShapeFaces` are the faces the built solid exposes;
// `newFaces` is the same set as extractNames receives it. The maker's
// Modified() is drained once per old face, mirroring applyEdgeModifier.
function runExtract(opts: {
  oc: OccModule
  maker: OccEdgeModifierMaker
  oldFaces: OccShape[]
  oldFaceNames: Record<string, string>
  newShapeFaces: OccShape[]
  newFaces: OccShape[]
  modifiedEdges?: OccShape[]
  oldEdgeNames?: Record<string, string>
}): NewNames {
  const scope = new DisposeScope()
  try {
    const old: OldNames = {
      createdBy: 'fillet1',
      faceNames: { ...opts.oldFaceNames },
      edgeNames: { ...(opts.oldEdgeNames ?? {}) },
      faceAncestry: {},
      edgeAncestry: {},
    }
    for (const uuid of Object.values(opts.oldFaceNames)) old.faceAncestry[uuid] = ['extrude1']
    for (const uuid of Object.values(opts.oldEdgeNames ?? {})) old.edgeAncestry[uuid] = ['extrude1']
    const oldFaceIdx = new SubShapeIndexMap()
    opts.oldFaces.forEach((f, i) => oldFaceIdx.set(f as OccSubShape, i))
    const oldFaceModified = new Map<number, OccShape[]>()
    for (const f of opts.oldFaces) {
      oldFaceModified.set(oldFaceIdx.get(f as OccSubShape), drainList(scope, opts.maker.Modified(f)))
    }
    return extractNames(
      opts.oc,
      scope,
      opts.maker,
      { faces: opts.newShapeFaces } as unknown as OccShape,
      opts.modifiedEdges ?? [],
      old,
      opts.oldFaces,
      opts.newFaces,
      oldFaceIdx,
      oldFaceModified,
    )
  } finally {
    scope.dispose()
  }
}

describe('extractNames split children / orphan image / generated failure', () => {
  it('mints one ordered child UUID per split sibling when a named face splits', () => {
    // A named face whose Modified() returns two children has to hand each child
    // a distinct, position-ordered UUID: a shared one would collide, and the
    // ancestral fallback would drop the face picks entirely.
    const oc = makeOcc()
    const scope = new DisposeScope()
    const parent = makeFace([0, 0, 0], [0, 0, 1], 4)
    const childA = makeFace([-1, 0, 0], [0, 0, 1])
    const childB = makeFace([1, 0, 0], [0, 0, 1])
    const maker = {
      ...makeMaker(childA),
      Modified: () => makeList([childA, childB]),
    } as unknown as OccEdgeModifierMaker
    const res = runExtract({
      oc,
      maker,
      oldFaces: [parent],
      oldFaceNames: { [faceGh(oc, scope, parent)]: 'uuid_P' },
      newShapeFaces: [childA, childB],
      newFaces: [childA, childB],
    })
    // Each child gets its own split-sibling UUID; which index lands on which
    // child is orderSplitChildren's contract, tested there.
    const expected = [
      mintFaceUuid(splitFacePath('uuid_P', 0)),
      mintFaceUuid(splitFacePath('uuid_P', 1)),
    ]
    expect(new Set(Object.values(res.faceNames))).toEqual(new Set(expected))
    for (const uuid of expected) expect(res.faceAncestry[uuid]).toEqual(['extrude1'])
  })

  it('hashes a Modified() image with no built-solid twin as itself, keeping the name', () => {
    // BRepFilletAPI can hand back a Modified() image the built solid does not
    // expose (an orientation/identity mismatch). Its geometry hash must still
    // carry the UUID rather than silently dropping the face.
    const oc = makeOcc()
    const scope = new DisposeScope()
    const oldF = makeFace([-1, -1, 0], [0, 0, 1])
    const twin = makeFace([5, 5, 0], [0, 0, 1])
    const orphan = makeFace([9, 9, 0], [0, 0, 1])
    const res = runExtract({
      oc,
      maker: makeMaker(orphan),
      oldFaces: [oldF],
      oldFaceNames: { [faceGh(oc, scope, oldF)]: 'uuid_A' },
      newShapeFaces: [twin],
      newFaces: [twin],
    })
    expect(res.faceNames[faceGh(oc, scope, orphan)]).toBe('uuid_A')
    expect(res.faceAncestry['uuid_A']).toEqual(['extrude1'])
  })

  it('treats a throwing Generated() as no fillet faces instead of failing the transfer', () => {
    // A flaky history query on one edge must not abort the whole name transfer:
    // the face names already assigned have to survive, and no fillet UUID is
    // minted from the failed edge.
    const oc = makeOcc()
    const scope = new DisposeScope()
    const oldF = makeFace([-1, -1, 0], [0, 0, 1])
    const twin = makeFace([5, 5, 0], [0, 0, 1])
    const edge = makeLineEdge([0, 0, 0], [1, 0, 0])
    const egh = edgeGh(oc, scope, edge)
    expect(egh).not.toBeNull()
    const maker = {
      ...makeMaker(twin),
      Generated: () => {
        throw new Error('history unavailable')
      },
    } as unknown as OccEdgeModifierMaker
    const res = runExtract({
      oc,
      maker,
      oldFaces: [oldF],
      oldFaceNames: { [faceGh(oc, scope, oldF)]: 'uuid_A' },
      newShapeFaces: [twin],
      newFaces: [twin],
      modifiedEdges: [edge],
      oldEdgeNames: { [egh as string]: 'edge_A' },
    })
    expect(res.faceNames[faceGh(oc, scope, twin)]).toBe('uuid_A')
    expect(Object.keys(res.faceNames)).toHaveLength(1)
    expect(res.faceAncestry[mintFaceUuid(filletFacePath('fillet1', 'edge_A'))]).toBeUndefined()
  })
})

// The guard/error-classification paths of applyEdgeModifier, driven through the
// public applyChamferWithDiff wrapper with a fake OCC module and maker. No
// geometry is built: each case pins which `reason` a refusal reports, since the
// caller surfaces that string to the user and keys its partial-status handling
// on it.
type EdgeFake = OccShape & { IsSame(other: unknown): boolean }

function makeEdgeFake(): EdgeFake {
  const edge = { IsSame: (o: unknown): boolean => o === edge, delete: () => {} }
  return edge as unknown as EdgeFake
}

interface EdgeOccOptions {
  shapeIsNull?: boolean
  shapeEdges?: EdgeFake[]
  shapeFaces?: EdgeFake[]
  makeMakerThrows?: boolean
  addThrowsFor?: EdgeFake
  buildThrows?: boolean
  isDone?: boolean
  valid?: boolean | ((shape: OccShape) => boolean)
  analyzerThrows?: boolean
  isDeletedThrows?: boolean
  modifiedThrows?: boolean
  // Shape the fake ShapeFix returns; a healed shape with different topology.
  healed?: OccShape
}

function makeEdgeOcc(opts: EdgeOccOptions = {}): { oc: OccModule; shape: OccShape } {
  const E = {
    TopAbs_VERTEX: { value: 0 },
    TopAbs_EDGE: { value: 1 },
    TopAbs_FACE: { value: 3 },
    TopAbs_SOLID: { value: 2 },
    TopAbs_SHAPE: { value: 8 },
  }
  const built = { faces: [], edges: [], delete: () => {} } as unknown as OccShape
  const maker = {
    Add_2: (_d: number, edge: OccShape): void => {
      if (edge === opts.addThrowsFor) throw new Error('addEdge rejected this edge')
    },
    AddDA: (): void => {},
    Build: (): void => {
      if (opts.buildThrows) throw new Error('build failed')
    },
    IsDone: (): boolean => opts.isDone ?? true,
    Shape: (): OccShape => built,
    IsDeleted: (): boolean => {
      if (opts.isDeletedThrows) throw new Error('history probe failed')
      return false
    },
    Modified: () => {
      if (opts.modifiedThrows) throw new Error('history unavailable')
      return { Size: () => 0, delete: () => {} }
    },
    Generated: () => ({ Size: () => 0, delete: () => {} }),
    delete: () => {},
  }
  const shape = {
    IsNull: (): boolean => opts.shapeIsNull ?? false,
    faces: opts.shapeFaces ?? [],
    edges: opts.shapeEdges ?? [],
    delete: () => {},
  } as unknown as OccShape
  const oc = {
    TopAbs_ShapeEnum: E,
    TopAbs_Orientation: { TopAbs_FORWARD: { value: 0 }, TopAbs_REVERSED: { value: 1 } },
    TopoDS: {
      Face_1: (s: OccShape) => s,
      Edge_1: (s: OccShape) => s,
    },
    TopExp_Explorer_2: function (s: OccShape, kind: object) {
      const holder = s as unknown as { faces?: OccShape[]; edges?: OccShape[] }
      const items = kind === E.TopAbs_FACE ? holder.faces ?? [] : kind === E.TopAbs_EDGE ? holder.edges ?? [] : []
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
    BRepFilletAPI_MakeChamfer: function () {
      if (opts.makeMakerThrows) throw new Error('maker unavailable')
      return maker
    },
    BRepCheck_Analyzer: function (analyzed: OccShape) {
      if (opts.analyzerThrows) throw new Error('analyzer unavailable')
      const v = typeof opts.valid === 'function' ? opts.valid(analyzed) : opts.valid ?? true
      return { IsValid_2: () => v, delete: () => {} }
    },
    ShapeFix_Shape_2: function () {
      return { Perform: (): void => {}, Shape: (): OccShape => opts.healed ?? built, delete: () => {} }
    },
    Handle_Message_ProgressIndicator_1: function () {
      return { delete: () => {} }
    },
    GProp_GProps_1: function () {
      return { mass: 1, Mass: function () { return this.mass }, delete: () => {} }
    },
    BRepGProp: {
      VolumeProperties_1: (): void => {},
    },
  } as unknown as OccModule
  return { oc, shape }
}

function runChamfer(
  oc: OccModule,
  shape: OccShape,
  edges: EdgeFake[],
  kind = 'distance',
): ReturnType<typeof applyChamferWithDiff> {
  return applyChamferWithDiff(oc, new DisposeScope(), shape, 1, edges, kind, 45)
}

describe('applyEdgeModifier guard / error classification', () => {
  it('refuses a null shape before building anything', () => {
    const { oc } = makeEdgeOcc()
    const shape = { IsNull: () => true } as unknown as OccShape
    const res = runChamfer(oc, shape, [makeEdgeFake()])
    expect(res.success).toBe(false)
    expect(res.reason).toBe('null_shape')
    // The old shape is handed back unchanged; the caller must not release it.
    expect(res.shape).toBe(shape)
  })

  it('reports maker_failed when the OCC builder cannot be constructed', () => {
    const { oc, shape } = makeEdgeOcc({ makeMakerThrows: true })
    const res = runChamfer(oc, shape, [makeEdgeFake()])
    expect(res.success).toBe(false)
    expect(res.reason).toBe('maker_failed')
  })

  it('reports no_edges_applied when no picked edge belongs to the shape', () => {
    const { oc, shape } = makeEdgeOcc()
    const res = runChamfer(oc, shape, [makeEdgeFake()])
    expect(res.success).toBe(false)
    expect(res.reason).toBe('no_edges_applied')
  })

  it('reports build_not_done when the maker finishes without a shape', () => {
    const edge = makeEdgeFake()
    const { oc, shape } = makeEdgeOcc({ shapeEdges: [edge], isDone: false })
    const res = runChamfer(oc, shape, [edge])
    expect(res.success).toBe(false)
    expect(res.reason).toBe('build_not_done')
  })

  it('reports build_failed when the maker throws during Build', () => {
    const edge = makeEdgeFake()
    const { oc, shape } = makeEdgeOcc({ shapeEdges: [edge], buildThrows: true })
    const res = runChamfer(oc, shape, [edge])
    expect(res.success).toBe(false)
    expect(res.reason).toBe('build_failed')
  })

  it('refuses an invalid result that ShapeFix cannot trust', () => {
    const edge = makeEdgeFake()
    // valid=false makes healShape return null, so the corruption is refused
    // rather than returned as a body. The fake ShapeFix/volume path is skipped
    // because healShape returns before it.
    const { oc, shape } = makeEdgeOcc({ shapeEdges: [edge], valid: false })
    const res = runChamfer(oc, shape, [edge])
    expect(res.success).toBe(false)
    expect(res.reason).toContain('invalid geometry')
  })

  it('applies the valid edges and reports the skipped one by index', () => {
    // Edge 0 is rejected by the maker, edge 1 applies. The result must stay
    // successful but flag index 0 so the UI can warn on that pick.
    const bad = makeEdgeFake()
    const good = makeEdgeFake()
    const { oc, shape } = makeEdgeOcc({ shapeEdges: [bad, good], addThrowsFor: bad })
    const res = runChamfer(oc, shape, [bad, good])
    expect(res.success).toBe(true)
    expect(res.reason).toBeNull()
    expect(res.skippedEdgeIndices).toEqual([0])
  })

  it('refuses an angle_distance chamfer whose edge belongs to no face', () => {
    const edge = makeEdgeFake()
    const { oc, shape } = makeEdgeOcc({ shapeEdges: [edge] })
    const res = runChamfer(oc, shape, [edge], 'angle_distance')
    expect(res.success).toBe(false)
    expect(res.reason).toBe('no_edges_applied')
  })

  it('reads a throwing validity analyzer as invalid and refuses the result', () => {
    // A validator that cannot run is not a vote of confidence: the result must
    // be refused rather than registered as a body on the strength of the throw.
    const edge = makeEdgeFake()
    const { oc, shape } = makeEdgeOcc({ shapeEdges: [edge], analyzerThrows: true })
    const res = runChamfer(oc, shape, [edge])
    expect(res.success).toBe(false)
    expect(res.reason).toContain('invalid geometry')
  })

  it('classifies the diff through a throwing IsDeleted probe instead of failing', () => {
    // edgeModifierDiff's classify treats a throwing IsDeleted as "not deleted";
    // the chamfer still succeeds with a (possibly empty) diff rather than
    // aborting the whole feature on a flaky history query.
    const edge = makeEdgeFake()
    const { oc, shape } = makeEdgeOcc({ shapeEdges: [edge], isDeletedThrows: true })
    const res = runChamfer(oc, shape, [edge])
    expect(res.success).toBe(true)
    expect(res.reason).toBeNull()
  })

  it('falls back to an empty diff when the history walk throws', () => {
    // A throwing Modified() in the edge classifier must not lose the successful
    // shape: the diff degrades to empty, which is the "no lineage" answer the
    // caller already handles, rather than failing the feature.
    const edge = makeEdgeFake()
    const { oc, shape } = makeEdgeOcc({ shapeEdges: [edge], modifiedThrows: true })
    const res = runChamfer(oc, shape, [edge])
    expect(res.success).toBe(true)
    expect(res.reason).toBeNull()
    expect(res.diff).toEqual(emptyBrepDiff())
  })

  it('refuses a heal that changes the face count rather than projecting a curve', () => {
    // ShapeFix is a projector, not a rebuilder. A heal that invents or drops a
    // face is the corrupt case wearing a repair, so it must be refused even
    // though the healed shape validates and keeps its volume.
    const edge = makeEdgeFake()
    const healedFace = { IsSame: (o: unknown) => o === healedFace, HashCode: () => 1, delete: () => {} }
    const healed = { faces: [healedFace], edges: [], delete: () => {} } as unknown as OccShape
    const { oc, shape } = makeEdgeOcc({
      shapeEdges: [edge],
      healed,
      valid: (analyzed) => analyzed === healed,
    })
    const res = runChamfer(oc, shape, [edge])
    expect(res.success).toBe(false)
    expect(res.reason).toContain('invalid geometry')
  })
})
