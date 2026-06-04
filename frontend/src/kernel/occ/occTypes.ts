/**
 * The slice of the opencascade.js (Donalffons fork, OCC 7.5) embind surface
 * that the phase-2a spike actually touches. Member names mirror the real
 * module exactly, so the live module satisfies this interface with a single
 * structural cast and the [[FakeOcc]] test double implements the same names.
 *
 * Overload suffixes (`_1`, `_2`, ...) and exact arities are not cosmetic: they
 * were pinned against the real 1.1.1 build (see the gated spike test and the
 * migration notes). Examples that bit during the spike:
 *   - `BRepPrimAPI_MakeBox_2` wants 4 args; the 3-arg box is `_1`.
 *   - `BRep_Tool.Triangulation` is 2 args in this build (no datatype arg).
 *   - There is no `TopTools_ListIteratorOfListOfShape`; drain a list with
 *     `Size()` + `First_1()` + `RemoveFirst()`.
 */

export interface OccDisposable {
  delete(): void
  /** opencascade.js embind proxies expose this guard. */
  isDeleted?(): boolean
}

// Distinct aliases for readability at call sites. Structurally all disposable.
export type OccShape = OccDisposable
export type OccPnt = OccDisposable
export type OccVec = OccDisposable

export interface OccPolygonBuilder extends OccDisposable {
  Add_1(p: OccPnt): void
  Close(): void
  Wire(): OccShape
}

export interface OccFaceBuilder extends OccDisposable {
  Face(): OccShape
}

export interface OccPrismBuilder extends OccDisposable {
  Shape(): OccShape
  /** Sub-shapes generated from a profile sub-shape: the lineage sharp edge. */
  Generated(s: OccShape): OccListOfShape
}

export interface OccListOfShape extends OccDisposable {
  Size(): number
  First_1(): OccShape
  RemoveFirst(): void
}

export interface OccExplorer extends OccDisposable {
  More(): boolean
  Next(): void
  Current(): OccShape
}

export interface OccTriangulation {
  NbTriangles(): number
}

export interface OccTriangulationHandle extends OccDisposable {
  IsNull(): boolean
  get(): OccTriangulation | null
}

/** Opaque embind enum value (e.g. `TopAbs_ShapeEnum.TopAbs_FACE`). */
export type OccShapeEnumValue = object

export interface OccModule {
  gp_Pnt_3: new (x: number, y: number, z: number) => OccPnt
  gp_Vec_4: new (x: number, y: number, z: number) => OccVec
  BRepBuilderAPI_MakePolygon_1: new () => OccPolygonBuilder
  BRepBuilderAPI_MakeFace_15: new (wire: OccShape, onlyPlane: boolean) => OccFaceBuilder
  BRepPrimAPI_MakePrism_1: new (
    profile: OccShape,
    direction: OccVec,
    copy: boolean,
    canonize: boolean,
  ) => OccPrismBuilder
  BRepMesh_IncrementalMesh_2: new (
    shape: OccShape,
    linearDeflection: number,
    isRelative: boolean,
    angularDeflection: number,
    parallel: boolean,
  ) => OccDisposable
  TopExp_Explorer_2: new (
    shape: OccShape,
    toFind: OccShapeEnumValue,
    toAvoid: OccShapeEnumValue,
  ) => OccExplorer
  TopAbs_ShapeEnum: {
    TopAbs_FACE: OccShapeEnumValue
    TopAbs_EDGE: OccShapeEnumValue
    TopAbs_SHAPE: OccShapeEnumValue
  }
  TopoDS: {
    Face_1(shape: OccShape): OccShape
  }
  TopLoc_Location_1: new () => OccDisposable
  BRep_Tool: {
    Triangulation(face: OccShape, loc: OccDisposable): OccTriangulationHandle
  }
}
