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
  Append_1(s: OccShape): void
}

/**
 * BRepTools_History from a boolean op (algo.History()) or a ShapeUpgrade
 * (unify.History_1()). The `Modified`/`Generated` lists drain via
 * Size/First_1/RemoveFirst -- there is no list-iterator binding in this build.
 */
export interface OccHistory extends OccDisposable {
  IsRemoved(s: OccShape): boolean
  Modified(s: OccShape): OccListOfShape
}

/** A Handle_BRepTools_History; `.get()` yields the History object. */
export interface OccHistoryHandle extends OccDisposable {
  get(): OccHistory
}

/** BRepAlgoAPI_Cut/Fuse/Common: the history-aware boolean operation. */
export interface OccBooleanOp extends OccDisposable {
  SetArguments(args: OccListOfShape): void
  SetTools(tools: OccListOfShape): void
  SetToFillHistory(fill: boolean): void
  Build(): void
  IsDone(): boolean
  HasHistory(): boolean
  History(): OccHistoryHandle
  Shape(): OccShape
}

/** ShapeUpgrade_UnifySameDomain: cadquery Shape.clean() with exposed history. */
export interface OccUnify extends OccDisposable {
  AllowInternalEdges(allow: boolean): void
  Build(): void
  Shape(): OccShape
  History_1(): OccHistoryHandle
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
  /** Only valid when GetType() is GeomAbs_Plane (used for face-profile planes). */
  Plane(): OccPln
}

/** gp_Pnt2d / gp_Dir2d: a 2D point or direction on a face's parameter space. */
export interface OccPnt2d extends OccDisposable {
  X(): number
  Y(): number
}

export interface OccCircle2d extends OccDisposable {
  Location(): OccPnt2d
  Radius(): number
}

/** BRepAdaptor_Curve2d: a face PCurve (2D parameter-space curve of an edge). */
export interface OccCurve2dAdaptor extends OccDisposable {
  FirstParameter(): number
  LastParameter(): number
  GetType(): OccEnumValue
  Circle(): OccCircle2d
  Value(u: number): OccPnt2d
}

export interface OccWireExplorer extends OccDisposable {
  More(): boolean
  Next(): void
  Current(): OccShape
}

/** gp_Ax3 read accessors (a plane's coordinate frame). */
export interface OccAx3 {
  Location(): OccXYZ
  XDirection(): OccXYZ
  YDirection(): OccXYZ
  Direction(): OccXYZ
}

export interface OccPln extends OccDisposable {
  Position(): OccAx3
}

export interface OccSLProps extends OccDisposable {
  Normal(): OccXYZ
  IsNormalDefined(): boolean
}

export interface OccEdgeBuilder extends OccDisposable {
  Edge(): OccShape
}

/** A handle (e.g. Handle_Geom_TrimmedCurve) whose `.get()` yields the object. */
export interface OccGeomHandle extends OccDisposable {
  get(): OccDisposable | null
}

export interface OccArcMaker extends OccDisposable {
  IsDone(): boolean
  Value(): OccGeomHandle
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

/** A sub-shape (edge/vertex) we dedup by topological identity. */
export interface OccSubShape extends OccDisposable {
  IsSame(other: OccDisposable): boolean
}

export interface OccAxisDir {
  Direction(): OccXYZ
}

export interface OccCircle extends OccDisposable {
  Location(): OccXYZ
  Radius(): number
  Axis(): OccAxisDir
  XAxis(): OccAxisDir
}

export interface OccCurveAdaptor extends OccDisposable {
  GetType(): OccEnumValue
  FirstParameter(): number
  LastParameter(): number
  Value(u: number): OccXYZ
  Circle(): OccCircle
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
  // Richer location + triangulation than the spike slice (node-level access),
  // plus VERTEX exploration, edge/vertex casts, and the curve adaptor.
  TopLoc_Location_1: new () => OccLocation
  BRep_Tool: {
    Triangulation(face: OccShape, loc: OccLocation): OccTriangulationHandle
    Pnt(vertex: OccShape): OccXYZ
  }
  TopAbs_ShapeEnum: {
    TopAbs_FACE: OccShapeEnumValue
    TopAbs_EDGE: OccShapeEnumValue
    TopAbs_VERTEX: OccShapeEnumValue
    TopAbs_SOLID: OccShapeEnumValue
    TopAbs_WIRE: OccShapeEnumValue
    TopAbs_SHAPE: OccShapeEnumValue
  }
  TopoDS: {
    Face_1(shape: OccShape): OccShape
    Edge_1(shape: OccShape): OccShape
    Vertex_1(shape: OccShape): OccShape
    Solid_1(shape: OccShape): OccShape
    Wire_1(shape: OccShape): OccShape
  }
  BRepAdaptor_Curve_2: new (edge: OccShape) => OccCurveAdaptor
  GeomAbs_CurveType: {
    GeomAbs_Line: OccEnumValue
    GeomAbs_Circle: OccEnumValue
  }

  // --- 2b: shape construction --------------------------------------------
  gp_Dir_4: new (x: number, y: number, z: number) => OccXYZ
  gp_Ax2_3: new (origin: OccPnt, normal: OccXYZ) => OccDisposable
  /** gp_Ax2(location, N, Vx): the 3-arg form used to orient a circle. */
  gp_Ax2_2: new (origin: OccPnt, normal: OccXYZ, xDir: OccXYZ) => OccDisposable
  gp_Circ_2: new (axis: OccDisposable, radius: number) => OccDisposable
  GC_MakeArcOfCircle_1: new (
    circle: OccDisposable,
    alpha1: number,
    alpha2: number,
    sense: boolean,
  ) => OccArcMaker
  Handle_Geom_Curve_2: new (curve: OccDisposable) => OccDisposable
  BRepBuilderAPI_MakeEdge_3: new (p1: OccPnt, p2: OccPnt) => OccEdgeBuilder
  BRepBuilderAPI_MakeEdge_8: new (circle: OccDisposable) => OccEdgeBuilder
  BRepBuilderAPI_MakeEdge_24: new (curve: OccDisposable) => OccEdgeBuilder
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
    /** Volume of a (closed) shape; mirrors cadquery Solid.Volume. */
    VolumeProperties_1(
      shape: OccShape,
      props: OccGProps,
      onlyClosed: boolean,
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

  // --- 2d: bounding box (classifier frame) --------------------------------
  Bnd_Box: new () => OccDisposable & {
    Get(): [number, number, number, number, number, number]
  }
  BRepBndLib: {
    Add_s(shape: OccShape, box: OccDisposable, useTriangulation: boolean): void
  }

  // --- 2e: boolean ops + history + clean ----------------------------------
  BRepAlgoAPI_Cut_1: new () => OccBooleanOp
  BRepAlgoAPI_Fuse_1: new () => OccBooleanOp
  BRepAlgoAPI_Common_1: new () => OccBooleanOp
  TopTools_ListOfShape_1: new () => OccListOfShape
  ShapeUpgrade_UnifySameDomain_2: new (
    shape: OccShape,
    unifyEdges: boolean,
    unifyFaces: boolean,
    concatBSplines: boolean,
  ) => OccUnify

  // --- 2e: face-profile loop extraction (extrude/revolve from a face) ------
  BRepTools: {
    OuterWire(face: OccShape): OccShape
  }
  BRepTools_WireExplorer_3: new (wire: OccShape, face: OccShape) => OccWireExplorer
  BRepAdaptor_Curve2d_2: new (edge: OccShape, face: OccShape) => OccCurve2dAdaptor
}

/** A face shape exposes its orientation (FORWARD/REVERSED) via Orientation_1. */
export interface OccOrientedShape extends OccShape {
  Orientation_1(): OccEnumValue
}
