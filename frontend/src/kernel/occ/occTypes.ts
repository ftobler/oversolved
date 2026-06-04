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

/** 3D point / direction: gp_Pnt, gp_Dir, gp_Vec all expose X/Y/Z accessors. */
export interface OccXYZ extends OccDisposable {
  X(): number
  Y(): number
  Z(): number
}

/** gp_Pnt additionally transforms by a gp_Trsf (mesh node -> world). */
export interface OccPntValue extends OccXYZ {
  Transformed(trsf: OccTrsf): OccPntValue
}

export type OccTrsf = OccDisposable

/** Embind enum value carrying a numeric `.value`. */
export interface OccEnumValue {
  value: number
}

export interface OccTriangle {
  /** 1-based node index for corner i (i in 1..3). */
  Value(i: number): number
}

/** Triangle-count only: all the 2a spike (FakeOcc leak gate) needs. */
export interface OccTriangulationBasic {
  NbTriangles(): number
}

/** Full node/triangle access, used by the 2b tessellation port. */
export interface OccTriangulation extends OccTriangulationBasic {
  NbNodes(): number
  /** 1-based node, in the triangulation's local frame (apply location Trsf). */
  Node(i: number): OccPntValue
  /** 1-based triangle. */
  Triangle(i: number): OccTriangle
}

export interface OccTriangulationHandleBasic extends OccDisposable {
  IsNull(): boolean
  get(): OccTriangulationBasic | null
}

export interface OccTriangulationHandle extends OccDisposable {
  IsNull(): boolean
  get(): OccTriangulation | null
}

export interface OccGProps extends OccDisposable {
  CentreOfMass(): OccXYZ
  Mass(): number
}

export interface OccSurfaceAdaptor extends OccDisposable {
  GetType(): OccEnumValue
  FirstUParameter(): number
  LastUParameter(): number
  FirstVParameter(): number
  LastVParameter(): number
}

export interface OccSLProps extends OccDisposable {
  Normal(): OccXYZ
  IsNormalDefined(): boolean
}

export interface OccEdgeBuilder extends OccDisposable {
  Edge(): OccShape
}

export interface OccWireBuilder extends OccDisposable {
  Add_1(edge: OccShape): void
  Wire(): OccShape
}

export interface OccShapeFixFace extends OccDisposable {
  FixOrientation_1(): boolean
  Perform(): void
  Face(): OccShape
}

export interface OccLocation extends OccDisposable {
  Transformation(): OccTrsf
}

/** Opaque embind enum value (e.g. `TopAbs_ShapeEnum.TopAbs_FACE`). */
export type OccShapeEnumValue = object

/**
 * The 2a spike slice: what `extrudeSquareAndTessellate` and the FakeOcc leak
 * gate need. The 2b construction surface lives on [[OccModule]], which extends
 * this. Keeping the spike slice separate means the in-memory FakeOcc double
 * does not have to fake the whole construction kernel.
 */
export interface OccSpikeModule {
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
    Triangulation(face: OccShape, loc: OccDisposable): OccTriangulationHandleBasic
  }
}

export interface OccModule extends OccSpikeModule {
  // Richer location + triangulation than the spike slice (node-level access).
  TopLoc_Location_1: new () => OccLocation
  BRep_Tool: {
    Triangulation(face: OccShape, loc: OccLocation): OccTriangulationHandle
  }

  // --- 2b: shape construction --------------------------------------------
  gp_Dir_4: new (x: number, y: number, z: number) => OccXYZ
  gp_Ax2_3: new (origin: OccPnt, normal: OccXYZ) => OccDisposable
  BRepBuilderAPI_MakeEdge_3: new (p1: OccPnt, p2: OccPnt) => OccEdgeBuilder
  BRepBuilderAPI_MakeWire_1: new () => OccWireBuilder
  BRepPrimAPI_MakeBox_1: new (dx: number, dy: number, dz: number) => OccPrismBuilder
  BRepPrimAPI_MakeCylinder_3: new (axis: OccDisposable, radius: number, height: number) => OccPrismBuilder
  ShapeFix_Face_2: new (face: OccShape) => OccShapeFixFace

  // --- 2b: geometry readers ----------------------------------------------
  GProp_GProps_1: new () => OccGProps
  BRepGProp: {
    SurfaceProperties_1(
      shape: OccShape,
      props: OccGProps,
      skipShared: boolean,
      useTriangulation: boolean,
    ): void
  }
  BRepAdaptor_Surface_2: new (face: OccShape, restriction: boolean) => OccSurfaceAdaptor
  BRepLProp_SLProps_1: new (
    surface: OccSurfaceAdaptor,
    u: number,
    v: number,
    derivativeOrder: number,
    resolution: number,
  ) => OccSLProps
  GeomAbs_SurfaceType: {
    GeomAbs_Plane: OccEnumValue
    GeomAbs_Cylinder: OccEnumValue
  }
  TopAbs_Orientation: {
    TopAbs_REVERSED: OccEnumValue
  }
}

/** A face shape exposes its orientation (FORWARD/REVERSED) via Orientation_1. */
export interface OccOrientedShape extends OccShape {
  Orientation_1(): OccEnumValue
}
