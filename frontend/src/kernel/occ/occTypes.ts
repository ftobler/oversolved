/**
 * The opencascade.js (Donalffons fork, OCCT 7.4.0p1) embind surface the kernel
 * actually touches. Member names mirror the real module exactly, so the live
 * module satisfies this interface with a single structural cast.
 *
 * Overload suffixes (`_1`, `_2`, ...) and exact arities are not cosmetic: they
 * were pinned against the real 1.1.1 build. Examples that bit during porting:
 *   - `BRepPrimAPI_MakeBox_2` wants 4 args; the 3-arg box is `_1`.
 *   - `BRep_Tool.Triangulation` is 2 args in this build (no datatype arg).
 *   - There is no `TopTools_ListIteratorOfListOfShape`; drain a list with
 *     `Size()` + `First_1()` + `RemoveFirst()`.
 */

export interface OccDisposable {
  delete(): void
  // opencascade.js embind proxies expose this guard.
  isDeleted?(): boolean
}

// Distinct aliases for readability at call sites. Structurally all disposable.
export type OccShape = OccDisposable
export type OccPnt = OccDisposable
export type OccVec = OccDisposable

/** A 1-based TColgp_Array1OfPnt (Bezier/BSpline poles). */
export interface OccPntArray extends OccDisposable {
  SetValue(index: number, pnt: OccPnt): void
}

/** TColStd_Array1OfReal(lower, upper): 1-based f64 array (B-spline knots). */
export interface OccRealArray extends OccDisposable {
  SetValue(index: number, value: number): void
}

/** TColStd_Array1OfInteger(lower, upper): 1-based integer array (multiplicities). */
export interface OccIntArray extends OccDisposable {
  SetValue(index: number, value: number): void
}

/** Geom_BSplineCurve(poles, knots, multiplicities, degree), with the knot
 *  removal the fit-spline writer uses to recover the C2 form. `NbPoles` and
 *  `Continuity` are the read-back a real-OCC test uses to prove the writer
 *  produced CadQuery's clamped C2 curve, not the C0 chain. */
export interface OccBSplineCurve extends OccDisposable {
  RemoveKnot(index: number, multiplicity: number, tolerance: number): boolean
  NbPoles(): number
  Continuity(): OccEnumValue
}

/** Handle_Geom_BSplineCurve: the smart-pointer wrapper `BRepAdaptor_Curve`
 *  hands back; `get()` reaches the curve without taking ownership of it. */
export interface OccBSplineHandle extends OccDisposable {
  get(): OccBSplineCurve
}

export interface OccPolygonBuilder extends OccDisposable {
  Add_1(p: OccPnt): void
  Close(): void
  Wire(): OccShape
}

export interface OccFaceBuilder extends OccDisposable {
  Face(): OccShape
  // False when the (wire, onlyPlane) face could not be built, e.g. non-coplanar.
  IsDone(): boolean
  // Add a hole wire to the face under construction (BRepBuilderAPI_MakeFace::Add).
  Add(wire: OccShape): void
}

export interface OccPrismBuilder extends OccDisposable {
  Shape(): OccShape
  // False when the prism/revolve builder could not complete (invalid profile,
  // degenerate axis, ...).
  IsDone(): boolean
  // Sub-shapes generated from a profile sub-shape: the lineage sharp edge.
  Generated(s: OccShape): OccListOfShape
  // The start (profile-side) generated shape; used to name the start cap.
  FirstShape?(): OccShape
  // The end (swept-to) generated shape; used to name the end cap.
  LastShape?(): OccShape
}

/** BRepPrimAPI_MakeCylinder: a prism builder whose primitive also hands out its
 *  three faces by role, the same faces (IsSame) its Shape() is made of. */
export interface OccCylinderBuilder extends OccPrismBuilder {
  Cylinder(): OccCylinderPrimitive
}

/** BRepPrim_Cylinder (a BRepPrim_OneAxis): the lateral face and the two discs,
 *  bottom at the axis origin and top at the far end of the height. */
export interface OccCylinderPrimitive extends OccDisposable {
  LateralFace(): OccShape
  TopFace(): OccShape
  BottomFace(): OccShape
}

export interface OccListOfShape extends OccDisposable {
  Size(): number
  First_1(): OccShape
  RemoveFirst(): void
  Append_1(s: OccShape): void
}

/**
 * BRepOffsetAPI_MakePipeShell: sweep a profile along a spine. Shares the
 * Shape()/Generated() lineage surface with OccPrismBuilder; adds the
 * sweep-specific setup + capping calls. `Add_1(profile, contact, correction)`
 * is the 3-arg overload; `SetTransitionMode` and `Build` take the default arg.
 */
export interface OccPipeShellBuilder extends OccPrismBuilder {
  SetTransitionMode(mode: OccEnumValue): void
  // The pipe-shell trihedron modes. BRepOffsetAPI_MakePipeShell declares four
  // SetMode overloads in this build (SpineSupport, gp_Ax2, gp_Dir, Frenet
  // boolean); the gp_Dir one is the binormal mode a constant-axis helix sweep
  // wants, pinning the profile's orientation to a fixed direction instead of
  // the CorrectedFrenet frame. The overload suffix is pinned by
  // helixEdgeProbeReal.test.ts.
  SetMode_3(dir: OccDisposable): void
  Add_1(profile: OccShape, withContact: boolean, withCorrection: boolean): void
  Build(): void
  IsDone(): boolean
  MakeSolid(): boolean
}

/**
 * The minimal history surface a name-transfer pass reads off any modifier: the
 * builder-style narration of what became of an input sub-shape. BRepFilletAPI,
 * BRepOffsetAPI_MakeThickSolid and BRepOffsetAPI_MakeOffsetShape (a
 * BRepBuilderAPI_MakeShape subclass) all expose it, so identity transfer is one
 * implementation over this shape rather than one per maker.
 */
export interface OccModifierHistory extends OccDisposable {
  IsDeleted(shape: OccShape): boolean
  Modified(shape: OccShape): OccListOfShape
  Generated(shape: OccShape): OccListOfShape
}

/**
 * BRepFilletAPI_Make{Fillet,Chamfer}: the edge-modifier makers. They share the
 * boolean-style history surface (IsDeleted / Modified / Generated) plus the
 * edge-add calls. `Add_2(value, edge)` is the (radius|distance, edge) overload;
 * `AddDA(distance, angle, edge, face)` is the chamfer angle-distance form: the
 * distance is measured on the reference FACE and the angle taken from it, so
 * the face is not optional. This declaration said three arguments until
 * 2026-09-15, which compiled fine and threw `BindingError: called with 3
 * arguments, expected 4` on every call.
 */
export interface OccEdgeModifierMaker extends OccModifierHistory {
  Add_2(value: number, edge: OccShape): void
  AddDA(distance: number, angle: number, edge: OccShape, face: OccShape): void
  Build(): void
  IsDone(): boolean
  Shape(): OccShape
}

/**
 * BRepOffsetAPI_MakeThickSolid: hollow a solid to a wall thickness with zero or
 * more closing (removed) faces. `MakeThickSolidByJoin` is the OCCT 7.4.0p1 9-arg
 * form (shape, closingFaces, offset, tol, mode, intersection, selfInter, join,
 * removeIntEdges); embind binds every argument, so the shorter defaults of some
 * OCCT wrappers are not available here. History: a kept face `Generated()` its
 * offset wall, a removed face `Modified()` into its rim.
 */
export interface OccThickSolidMaker extends OccModifierHistory {
  MakeThickSolidByJoin(
    shape: OccShape,
    closingFaces: OccListOfShape,
    offset: number,
    tol: number,
    mode: OccEnumValue,
    intersection: boolean,
    selfInter: boolean,
    join: OccEnumValue,
    removeIntEdges: boolean,
  ): void
  Build(): void
  IsDone(): boolean
  Shape(): OccShape
}

/**
 * BRepOffsetAPI_MakeOffsetShape: the 3D offset/clearance maker and the shell
 * fallback (a BRepBuilderAPI_MakeShape subclass, so it shares the builder
 * history surface). `PerformByJoin` is the OCCT 7.4.0p1 8-arg form (shape, offset,
 * tol, mode, intersection, selfInter, join, thickening); there is no
 * `Message_ProgressRange` overload in this build. History is `Generated` (NOT
 * `Modified`): for every source face exactly one grown face comes back, which
 * `IsSame`s a face of the result. `Shape()` is untracked for our purposes (the
 * caller owns it/registers it).
 */
export interface OccOffsetShapeMaker extends OccModifierHistory {
  PerformByJoin(
    shape: OccShape,
    offset: number,
    tol: number,
    mode: OccEnumValue,
    intersection: boolean,
    selfInter: boolean,
    join: OccEnumValue,
    removeIntEdges: boolean,
  ): void
  Build(): void
  IsDone(): boolean
  Shape(): OccShape
}

/**
 * BRepAlgoAPI_Defeaturing: remove faces and heal the gap by extending the
 * neighbours' surfaces. It is a BRepAlgoAPI_BuilderAlgo, so it shares the
 * boolean-style history surface (IsDeleted / Modified / Generated, present only
 * after `SetToFillHistory(true)`) without the boolean argument/tool calls.
 *
 * Bound methods pinned against opencascade.js 1.1.1 (OCCT 7.4.0p1) by
 * defeatureReal.test.ts: `SetShape`, `AddFaceToRemove`, `AddFacesToRemove`,
 * `SetToFillHistory`, `Build`, `IsDone`, `Shape`, `IsDeleted`, `Modified`,
 * `Generated`. The BOPAlgo_Options side (`HasErrors` / warnings) is NOT bound,
 * so the "feature could not be removed" warning OCCT prints is invisible here;
 * `IsDeleted(face) == false` on a requested face is the only failure signal
 * (a silent no-op otherwise reads as a valid result).
 */
export interface OccDefeaturingMaker extends OccModifierHistory {
  SetShape(shape: OccShape): void
  AddFaceToRemove(face: OccShape): void
  AddFacesToRemove(faces: OccListOfShape): void
  SetToFillHistory(fill: boolean): void
  Build(): void
  IsDone(): boolean
  Shape(): OccShape
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

/** BRepAlgoAPI_Splitter: split an argument shape by tool shapes (faces or
 *  solids). A plain BRepAlgoAPI_BuilderAlgo, so it has no history surface --
 *  declared on its own rather than as an OccBooleanOp. */
export interface OccSplitter extends OccDisposable {
  SetArguments(args: OccListOfShape): void
  SetTools(tools: OccListOfShape): void
  Build(): void
  IsDone(): boolean
  Shape(): OccShape
}

/** One BRepOffset_Interval: the edge-convexity the analyse classified. */
export interface OccOffsetInterval extends OccDisposable {
  Type_2(): OccEnumValue
}

/** BRepOffset_ListOfInterval: the intervals an edge belongs to (empty for an
 *  edge the analyse did not see). First_1() reads the first; there is no
 *  iterator binding in this build. */
export interface OccOffsetIntervalList extends OccDisposable {
  Size(): number
  First_1(): OccOffsetInterval
}

/** BRepOffset_Analyse: classify a solid's edges Convex / Concave / Tangent
 *  against an angular tolerance. `Type(edge)` yields the intervals of one edge. */
export interface OccOffsetAnalyse extends OccDisposable {
  Type(edge: OccShape): OccOffsetIntervalList
}

/** BRepClass_FaceClassifier: classify a point against a face (IN / ON / OUT).
 *  Constructed empty, then Perform_2 run per point. */
export interface OccFaceClassifier extends OccDisposable {
  // The 3D form: the point is projected onto the face's surface first.
  Perform_2(face: OccShape, pnt: OccPnt, tol: number): void
  // The 2D form: the point is already in the surface's parameter space, so it
  // classifies against the face's wires without the projection (which is
  // unreliable on a closed surface: a point below a cone's base circle
  // projects onto the other nappe). Move-face's curved kinds use this one.
  Perform_1(face: OccShape, pnt2d: OccPnt2d, tol: number): void
  State(): OccEnumValue
}

/** BRep_Builder: the low-level builder used to assemble a TopoDS_Compound, and
 *  to promote a TopoDS_Shell into a TopoDS_Solid for the offset normalisation. */
export interface OccBRepBuilder extends OccDisposable {
  MakeCompound(compound: OccShape): void
  MakeSolid(solid: OccShape): void
  Add(parent: OccShape, shape: OccShape): void
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
  // Allocates a new point; the caller owns it. Prefer `Transform` in hot loops.
  Transformed(trsf: OccTrsf): OccPntValue
  // In-place transform -- no allocation.
  Transform(trsf: OccTrsf): void
}

/** Embind enum value carrying a numeric `.value`. */
export interface OccEnumValue {
  value: number
}

export interface OccTriangle extends OccDisposable {
  // 1-based node index for corner i (i in 1..3).
  Value(i: number): number
}

/** Triangle-count only: what the mesh handling needs. */
export interface OccTriangulationBasic {
  NbTriangles(): number
}

/** Full node/triangle access, used by the tessellation port. */
export interface OccTriangulation extends OccTriangulationBasic {
  NbNodes(): number
  // 1-based node, in the triangulation's local frame (apply location Trsf).
  Node(i: number): OccPntValue
  // 1-based triangle.
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
  // Only valid when GetType() is GeomAbs_Plane (used for face-profile planes).
  Plane(): OccPln
  // Point + first derivatives at (u, v); p/du/dv are caller-allocated out-params.
  D1(u: number, v: number, p: OccXYZ, du: OccXYZ, dv: OccXYZ): void
  // Only valid when GetType() is GeomAbs_Cylinder.
  Cylinder(): OccAnalyticCylinder
  // Only valid when GetType() is GeomAbs_Cone.
  Cone(): OccAnalyticCone
  // Only valid when GetType() is GeomAbs_Sphere.
  Sphere(): OccAnalyticSphere
  // Only valid when GetType() is GeomAbs_Torus.
  Torus(): OccAnalyticTorus
}

/** gp_Cylinder read accessors (BRepAdaptor_Surface.Cylinder()). */
export interface OccAnalyticCylinder extends OccDisposable {
  Axis(): OccAxisDir
  Position(): OccAx3
  Radius(): number
}

/** gp_Cone read accessors (BRepAdaptor_Surface.Cone()). `SemiAngle` is the half
 *  angle from the axis: the move-face extender needs it to stop the extended
 *  face at the apex (only one nappe may split the slab). */
export interface OccAnalyticCone extends OccDisposable {
  Axis(): OccAxisDir
  Position(): OccAx3
  RefRadius(): number
  SemiAngle(): number
}

/** gp_Sphere read accessors (BRepAdaptor_Surface.Sphere()). */
export interface OccAnalyticSphere extends OccDisposable {
  Position(): OccAx3
  Radius(): number
}

/** gp_Torus read accessors (BRepAdaptor_Surface.Torus()). */
export interface OccAnalyticTorus extends OccDisposable {
  Axis(): OccAxisDir
  Position(): OccAx3
  MajorRadius(): number
  MinorRadius(): number
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

/** gp_Ax3 read accessors (a plane's coordinate frame). By-value embind return:
 *  each Position()/accessor proxy owns WASM memory and must be deleted. */
export interface OccAx3 extends OccDisposable {
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

/**
 * A handle (e.g. Handle_Geom_TrimmedCurve) whose `.get()` yields the object.
 * `.get()` mints a FRESH embind wrapper per call in this build (probed in
 * occ/primitivesReal.test.ts, wave 10 D2): never rely on two results being the
 * same JS object. Each wrapper is a borrowed view of a C++ object the handle
 * owns, so it must NOT be `.delete()`d (that frees the object out from under
 * the handle, stepIo.ts:189-191); each call only strands a small JS-side
 * wrapper registration.
 */
export interface OccGeomHandle extends OccDisposable {
  get(): OccDisposable | null
}

export interface OccArcMaker extends OccDisposable {
  IsDone(): boolean
  Value(): OccGeomHandle
}

export interface OccWireBuilder extends OccDisposable {
  Add_1(edge: OccShape): void
  // False when the added edges do not chain into a single connected wire.
  IsDone(): boolean
  Wire(): OccShape
}

export interface OccShapeFixFace extends OccDisposable {
  FixOrientation_1(): boolean
  Perform(): void
  Face(): OccShape
}

export interface OccShapeFixWire extends OccDisposable {
  Load_1(wire: OccShape): void
  SetPrecision(precision: number): void
  FixReorder_1(): boolean
  FixConnected_1(precision: number): boolean
  Perform(): void
  Wire(): OccShape
}

export interface OccLocation extends OccDisposable {
  Transformation(): OccTrsf
}

/** A sub-shape (edge/vertex) we dedup by topological identity. */
export interface OccSubShape extends OccDisposable {
  IsSame(other: OccDisposable): boolean
  // True when the two shapes share the same TShape (ignores orientation).
  IsPartner(other: OccDisposable): boolean
  /** The same shape carried under `loc`. Passing an identity `TopLoc_Location`
   *  strips the placement, which is what makes `IsSame`/`HashCode` compare two
   *  differently-placed instances of one TShape as equal. */
  Located(loc: OccDisposable): OccShape
  /** TShape-derived hash in [1, upperBound], orientation-independent (matches
   *  `IsSame`). Bounded, so equal hashes still need an `IsSame` confirm. */
  HashCode(upperBound: number): number
}

/** gp_Ax1 read accessors (gp_Circle/gp_Ellipse .Axis()/.XAxis()). By-value
 *  embind return: the proxy owns WASM memory and must be deleted. */
export interface OccAxisDir extends OccDisposable {
  Direction(): OccXYZ
}

export interface OccCircle extends OccDisposable {
  Location(): OccXYZ
  Radius(): number
  Axis(): OccAxisDir
  XAxis(): OccAxisDir
}

export interface OccEllipse extends OccDisposable {
  Location(): OccXYZ
  MajorRadius(): number
  MinorRadius(): number
  Axis(): OccAxisDir
  XAxis(): OccAxisDir
}

export interface OccCurveAdaptor extends OccDisposable {
  GetType(): OccEnumValue
  FirstParameter(): number
  LastParameter(): number
  Value(u: number): OccXYZ
  Circle(): OccCircle
  Ellipse(): OccEllipse
  /** The B-spline this edge was built from (only when GetType is
   *  GeomAbs_BSplineCurve). */
  BSpline(): OccBSplineHandle
}

/** Opaque embind enum value (e.g. `TopAbs_ShapeEnum.TopAbs_FACE`). */
export type OccShapeEnumValue = object

/**
 * The base slice [[OccModule]] extends: the builders, explorers and
 * triangulation access the whole construction surface shares. Splitting it
 * from the richer [[OccModule]] lets the live module override only what it
 * augments.
 */
export interface OccBaseModule {
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

export interface OccModule extends OccBaseModule {
  // Richer location + triangulation than the base slice (node-level access),
  // plus VERTEX exploration, edge/vertex casts, and the curve adaptor.
  TopLoc_Location_1: new () => OccLocation
  BRep_Tool: {
    Triangulation(face: OccShape, loc: OccLocation): OccTriangulationHandle
    Pnt(vertex: OccShape): OccXYZ
    Degenerated(edge: OccShape): boolean
    /** IsClosed(edge, face): the edge is a seam of the face (it bounds the
     *  face on both sides). The 2-arg overload, pinned by probe and used by
     *  move-face to skip a curved face's own seam. */
    IsClosed_2(edge: OccShape, face: OccShape): boolean
  }
  TopAbs_ShapeEnum: {
    TopAbs_FACE: OccShapeEnumValue
    TopAbs_EDGE: OccShapeEnumValue
    TopAbs_VERTEX: OccShapeEnumValue
    TopAbs_SOLID: OccShapeEnumValue
    TopAbs_SHELL: OccShapeEnumValue
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
  // A default-constructed TopoDS_Solid, filled by BRep_Builder.MakeSolid + Add.
  TopoDS_Solid: new () => OccShape
  BRepAdaptor_Curve_2: new (edge: OccShape) => OccCurveAdaptor
  GeomAbs_CurveType: {
    GeomAbs_Line: OccEnumValue
    GeomAbs_Circle: OccEnumValue
    GeomAbs_Ellipse: OccEnumValue
    GeomAbs_BSplineCurve: OccEnumValue
  }

  // ─── shape construction ───
  gp_Dir_4: new (x: number, y: number, z: number) => OccXYZ
  gp_Ax2_3: new (origin: OccPnt, normal: OccXYZ) => OccDisposable
  // gp_Ax2(location, N, Vx): the 3-arg form used to orient a circle.
  gp_Ax2_2: new (origin: OccPnt, normal: OccXYZ, xDir: OccXYZ) => OccDisposable
  gp_Circ_2: new (axis: OccDisposable, radius: number) => OccDisposable
  GC_MakeArcOfCircle_1: new (
    circle: OccDisposable,
    alpha1: number,
    alpha2: number,
    sense: boolean,
  ) => OccArcMaker
  // GC_MakeArcOfEllipse(elips, alpha1, alpha2, sense): a trimmed elliptical arc.
  GC_MakeArcOfEllipse_1: new (
    elips: OccDisposable,
    alpha1: number,
    alpha2: number,
    sense: boolean,
  ) => OccArcMaker
  Handle_Geom_Curve_2: new (curve: OccDisposable) => OccDisposable
  // TColgp_Array1OfPnt(lower, upper): 1-based point array (Bezier poles).
  TColgp_Array1OfPnt_2: new (lower: number, upper: number) => OccPntArray
  // Geom_BezierCurve(poles): a Bezier curve through the pole array.
  Geom_BezierCurve_1: new (poles: OccPntArray) => OccDisposable
  // TColStd arrays: knots (f64) and multiplicities (integer).
  TColStd_Array1OfReal_2: new (lower: number, upper: number) => OccRealArray
  TColStd_Array1OfInteger_2: new (lower: number, upper: number) => OccIntArray
  // Geom_BSplineCurve(poles, knots, multiplicities, degree): the fit-spline
  // writer hands OCC the C0 chain, then removes the interior knots to reach
  // the C2 form CadQuery builds.
  Geom_BSplineCurve_1: new (
    poles: OccPntArray,
    knots: OccRealArray,
    multiplicities: OccIntArray,
    degree: number,
    periodic: boolean,
  ) => OccBSplineCurve
  // gp_Elips(axis, majorRadius, minorRadius): an ellipse in the axis frame.
  gp_Elips_2: new (axis: OccDisposable, majorRadius: number, minorRadius: number) => OccDisposable
  // Geom_Ellipse(elips): the parametric ellipse curve.
  Geom_Ellipse_1: new (elips: OccDisposable) => OccDisposable
  BRepBuilderAPI_MakeEdge_3: new (p1: OccPnt, p2: OccPnt) => OccEdgeBuilder
  BRepBuilderAPI_MakeEdge_8: new (circle: OccDisposable) => OccEdgeBuilder
  BRepBuilderAPI_MakeEdge_24: new (curve: OccDisposable) => OccEdgeBuilder
  BRepBuilderAPI_MakeWire_1: new () => OccWireBuilder
  BRepPrimAPI_MakeBox_1: new (dx: number, dy: number, dz: number) => OccPrismBuilder
  // BRepPrimAPI_MakeBox(corner, dx, dy, dz): an axis-aligned box at a corner.
  BRepPrimAPI_MakeBox_2: new (corner: OccPnt, dx: number, dy: number, dz: number) => OccPrismBuilder
  BRepPrimAPI_MakeCylinder_3: new (axis: OccDisposable, radius: number, height: number) => OccCylinderBuilder
  // BRepPrimAPI_MakeCone(ax2, r1, r2, height): a cone/frustum (r1 at the axis
  // origin, r2 at the far end; r2 = 0 makes a full cone).
  BRepPrimAPI_MakeCone_3: new (
    axis: OccDisposable,
    r1: number,
    r2: number,
    height: number,
  ) => OccPrismBuilder
  ShapeFix_Face_2: new (face: OccShape) => OccShapeFixFace
  ShapeFix_Wire_1: new () => OccShapeFixWire

  // ─── geometry readers ───
  GProp_GProps_1: new () => OccGProps
  BRepGProp: {
    SurfaceProperties_1(
      shape: OccShape,
      props: OccGProps,
      skipShared: boolean,
      useTriangulation: boolean,
    ): void
    // Volume of a (closed) shape; mirrors cadquery Solid.Volume.
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
    GeomAbs_Cone: OccEnumValue
    GeomAbs_Sphere: OccEnumValue
    GeomAbs_Torus: OccEnumValue
    GeomAbs_BezierSurface: OccEnumValue
    GeomAbs_BSplineSurface: OccEnumValue
    GeomAbs_SurfaceOfRevolution: OccEnumValue
    GeomAbs_SurfaceOfExtrusion: OccEnumValue
    GeomAbs_OffsetSurface: OccEnumValue
    GeomAbs_OtherSurface: OccEnumValue
  }
  TopAbs_Orientation: {
    TopAbs_REVERSED: OccEnumValue
  }

  // ─── bounding box ───
  // The embind suffix is `_1` (the plain `Bnd_Box` name is bound without a
  // constructor), and `Get` takes six out-params emscripten does not marshal,
  // so the per-corner accessors are the working read. Verified against
  // opencascade.js@1.1.1 (OCCT 7.4.0p1).
  Bnd_Box_1: new () => OccDisposable & {
    GetXmin(): number
    GetYmin(): number
    GetZmin(): number
    GetXmax(): number
    GetYmax(): number
    GetZmax(): number
  }
  BRepBndLib: {
    // Enlarges by each sub-shape's tolerance and boxes a B-spline's control
    // net. Tight enough for the oracle's analytic surfaces, not what an
    // external tool reports.
    Add(shape: OccShape, box: OccDisposable, useTriangulation: boolean): void
    // The optimal box: no triangulation, no shape tolerance. It is exact over
    // the face's parameter rectangle; a trim can leave that rectangle larger
    // than the face itself, which `faceBounds.ts` corrects for the measure
    // record. `AddOptimal` is the 4-arg binding in this build (the wasm also
    // names AddOptimal_1/_2, which embind does not expose); pinned by
    // measureLocallyReal.test.ts.
    AddOptimal(
      shape: OccShape,
      box: OccDisposable,
      useTriangulation: boolean,
      useShapeTolerance: boolean,
    ): void
  }

  // ─── boolean ops + history + clean ───
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

  // ─── 3D offset / clearance (offsetShape.ts) ───
  // BRepOffsetAPI_MakeOffsetShape: the plain (suffix-free) maker is the one
  // bound; PerformByJoin's offset-mode and join-type args come from the two enums.
  BRepOffsetAPI_MakeOffsetShape_1: new () => OccOffsetShapeMaker
  BRepOffset_Mode: {
    BRepOffset_Skin: OccEnumValue
    BRepOffset_Pipe: OccEnumValue
    BRepOffset_RectoVerso: OccEnumValue
  }
  GeomAbs_JoinType: {
    GeomAbs_Arc: OccEnumValue
    GeomAbs_Tangent: OccEnumValue
    GeomAbs_Intersection: OccEnumValue
  }

  // ─── canonical surface recognition (canonicalSurfaces.ts) ───
  gp_Pnt_1: new () => OccXYZ
  gp_Vec_1: new () => OccXYZ
  // gp_Ax3(location, N, Vx): a cylinder frame; Vx fixes where the U=0 seam sits.
  gp_Ax3_3: new (origin: OccPnt, normal: OccXYZ, xDir: OccXYZ) => OccDisposable
  gp_Cylinder_2: new (frame: OccDisposable, radius: number) => OccDisposable
  // BRepBuilderAPI_MakeFace(gp_Cylinder, wire, inside): a face on an analytic cylinder.
  BRepBuilderAPI_MakeFace_17: new (
    cylinder: OccDisposable,
    wire: OccShape,
    inside: boolean,
  ) => OccFaceBuilder
  BRepTools_ReShape: new () => OccReShape
  ShapeFix_Shape_2: new (shape: OccShape) => OccShapeFixShape
  // Null progress indicator (ShapeFix_Shape.Perform requires the argument).
  Handle_Message_ProgressIndicator_1: new () => OccDisposable
  // BRepCheck_Analyzer(shape, geomControls): plain (suffix-free) ctor in this build.
  BRepCheck_Analyzer: new (shape: OccShape, geomControls: boolean) => OccShapeAnalyzer

  // ─── assembly export: gather disjoint bodies into one compound shape ───
  // STEP/STL export of a whole assembly writes a single TopoDS_Compound built
  // from every body's solid. Unlike a boolean fuse this never fails on disjoint
  // parts, so an assembly of separate solids exports cleanly. In this OCC build
  // both classes have plain (suffix-free) default constructors.
  BRep_Builder: new () => OccBRepBuilder
  TopoDS_Compound: new () => OccShape

  // ─── face-profile loop extraction (extrude/revolve from a face) ───
  BRepTools: {
    OuterWire(face: OccShape): OccShape
  }
  BRepTools_WireExplorer_3: new (wire: OccShape, face: OccShape) => OccWireExplorer
  BRepAdaptor_Curve2d_2: new (edge: OccShape, face: OccShape) => OccCurve2dAdaptor

  // ─── revolve leaf ───
  // gp_Ax1(location, direction): the axis a revolve sweeps around.
  gp_Ax1_2: new (origin: OccPnt, direction: OccXYZ) => OccDisposable
  // BRepPrimAPI_MakeRevol(profile, axis, angleRad, copy): the 4-arg form.
  BRepPrimAPI_MakeRevol_1: new (
    profile: OccShape,
    axis: OccDisposable,
    angle: number,
    copy: boolean,
  ) => OccPrismBuilder

  // ─── sweep leaf ───
  // BRepOffsetAPI_MakePipeShell(spineWire): no overload suffix in this build.
  BRepOffsetAPI_MakePipeShell: new (spine: OccShape) => OccPipeShellBuilder
  BRepBuilderAPI_TransitionMode: {
    BRepBuilderAPI_RightCorner: OccEnumValue
    BRepBuilderAPI_Transformed: OccEnumValue
    BRepBuilderAPI_RoundCorner: OccEnumValue
  }

  // ─── helix: an edge in a cylinder surface's parameter space ───
  // BRepBuilderAPI_MakeEdge(Handle(Geom2d_Curve), Handle(Geom_Surface), p1, p2):
  // the parametric-space overload (_31 by declaration order, pinned by the
  // probe). Geom2d_Line in (u, v) space where u is angle and v is axial, then
  // BuildCurves3d lifts it to a 3D BSpline edge on the cylinder.
  Geom_CylindricalSurface_1: new (frame: OccDisposable, radius: number) => OccDisposable
  Geom2d_Line_3: new (pnt: OccDisposable, dir: OccDisposable) => OccDisposable
  gp_Pnt2d_3: new (x: number, y: number) => OccPnt2d
  gp_Dir2d_4: new (x: number, y: number) => OccDisposable
  Handle_Geom2d_Curve_2: new (curve: OccDisposable) => OccDisposable
  Handle_Geom_Surface_2: new (surface: OccDisposable) => OccDisposable
  BRepBuilderAPI_MakeEdge_31: new (
    curve: OccDisposable,
    surface: OccDisposable,
    p1: number,
    p2: number,
  ) => OccEdgeBuilder
  // BRepLib::BuildCurves3d(shape, tolerance, continuity, maxDegree, maxSegment):
  // approximates the parametrically-built edge into its 3D form. The 5-arg
  // overload is _1 in this build (the shape-only form is _2), pinned by
  // helixEdgeProbeReal.test.ts.
  BRepLib: {
    BuildCurves3d_1(
      shape: OccShape,
      tolerance: number,
      continuity: OccEnumValue,
      maxDegree: number,
      maxSegment: number,
    ): void
  }
  GeomAbs_Shape: {
    GeomAbs_C0: OccEnumValue
    GeomAbs_C1: OccEnumValue
    GeomAbs_C2: OccEnumValue
    GeomAbs_C3: OccEnumValue
    GeomAbs_CN: OccEnumValue
  }

  // ─── fillet / chamfer leaf ───
  // BRepFilletAPI_MakeFillet(shape, ChFi3d_Rational): the 2-arg form.
  BRepFilletAPI_MakeFillet: new (shape: OccShape, fshape: OccEnumValue) => OccEdgeModifierMaker
  // BRepFilletAPI_MakeChamfer(shape): the 1-arg form.
  BRepFilletAPI_MakeChamfer: new (shape: OccShape) => OccEdgeModifierMaker
  ChFi3d_FilletShape: {
    ChFi3d_Rational: OccEnumValue
  }

  // ─── shell leaf ───
  // BRepOffsetAPI_MakeThickSolid: the shell's open-face maker. The `_1` ctor is
  // the default form the shipped build binds (verified against opencascade.js
  // 1.1.1, OCCT 7.4.0p1). It shares BRepOffsetAPI_MakeOffsetShape (declared with
  // the clearance block above) and the two join enums.
  BRepOffsetAPI_MakeThickSolid_1: new () => OccThickSolidMaker

  // ─── move-face leaf ───
  // Split a slab by extended neighbour faces, then fuse/cut the cells under the
  // picked face. Bindings pinned by occ/__tests__/moveFaceReal.test.ts.
  BRepAlgoAPI_Splitter_1: new () => OccSplitter
  // BRepOffset_Analyse(shape, angleTol): edge convexity classification.
  BRepOffset_Analyse_2: new (shape: OccShape, angle: number) => OccOffsetAnalyse
  BRepOffset_Type: {
    BRepOffset_Convex: OccEnumValue
    BRepOffset_Concave: OccEnumValue
    BRepOffset_Tangent: OccEnumValue
    BRepOffset_FreeBoundary: OccEnumValue
    BRepOffset_Other: OccEnumValue
  }
  // BRepClass_FaceClassifier(): empty ctor + Perform_2(face, pnt, tol).
  BRepClass_FaceClassifier_1: new () => OccFaceClassifier
  // BRepClass3d_SolidClassifier(solid, pnt, tol): classify a point against a
  // solid; the cavity fold uses it to find which solid encloses a void.
  BRepClass3d_SolidClassifier_3: new (solid: OccShape, pnt: OccXYZ, tol: number) => OccDisposable & { State(): OccEnumValue }
  TopAbs_State: {
    TopAbs_IN: OccEnumValue
    TopAbs_OUT: OccEnumValue
    TopAbs_ON: OccEnumValue
    TopAbs_UNKNOWN: OccEnumValue
  }
  // BRepBuilderAPI_MakeFace on an analytic surface with a parameter window:
  // _9 plane, _10 cylinder, _11 cone. The v range is the surface's own (a
  // cylinder's is axial, a cone's is slant-length).
  BRepBuilderAPI_MakeFace_9: new (
    pln: OccDisposable,
    umin: number,
    umax: number,
    vmin: number,
    vmax: number,
  ) => OccFaceBuilder
  BRepBuilderAPI_MakeFace_10: new (
    cyl: OccDisposable,
    umin: number,
    umax: number,
    vmin: number,
    vmax: number,
  ) => OccFaceBuilder
  BRepBuilderAPI_MakeFace_11: new (
    cone: OccDisposable,
    umin: number,
    umax: number,
    vmin: number,
    vmax: number,
  ) => OccFaceBuilder
  // BRepBuilderAPI_MakeFace(surface, wire, inside): a face on the analytic
  // surface bounded by a wire that lies on it, one overload per surface kind:
  // _17 cylinder (declared with canonicalSurfaces above, the same binding),
  // _18 cone, _19 sphere, _20 torus. Move-face builds the classification
  // regions (the picked face's outer wire and its inner hole/boss loops) with
  // these; pinned by moveFaceCurvedReal.test.ts.
  BRepBuilderAPI_MakeFace_18: new (cone: OccDisposable, wire: OccShape, inside: boolean) => OccFaceBuilder
  BRepBuilderAPI_MakeFace_19: new (sphere: OccDisposable, wire: OccShape, inside: boolean) => OccFaceBuilder
  BRepBuilderAPI_MakeFace_20: new (torus: OccDisposable, wire: OccShape, inside: boolean) => OccFaceBuilder
  // The sphere and torus primitives move-face grows its curved slabs from:
  // BRepPrimAPI_MakeSphere(point, radius) and BRepPrimAPI_MakeTorus(ax2, R, r).
  // Pinned by moveFaceCurvedReal.test.ts.
  BRepPrimAPI_MakeSphere_5: new (centre: OccDisposable, radius: number) => OccPrismBuilder
  BRepPrimAPI_MakeTorus_5: new (
    axis: OccDisposable,
    major: number,
    minor: number,
  ) => OccPrismBuilder

  // ─── delete-face leaf ───
  // BRepAlgoAPI_Defeaturing: remove picked faces, extend the neighbour surfaces
  // and re-intersect. The plain (suffix-free) ctor is what the shipped build
  // binds, pinned by defeatureReal.test.ts.
  BRepAlgoAPI_Defeaturing: new () => OccDefeaturingMaker

  // ─── transform / mirror / array group ───
  gp_Trsf_1: new () => OccTrsf
  // BRepBuilderAPI_Transform(shape, trsf, copy): apply a gp_Trsf to a shape.
  BRepBuilderAPI_Transform_2: new (shape: OccShape, trsf: OccTrsf, copy: boolean) => OccTransformBuilder
  /** BRepBuilderAPI_Copy(shape, copyGeom, copyMesh): independent deep copy of a
   *  shape (the defensive copy used to isolate checkpoint snapshots). */
  BRepBuilderAPI_Copy_2: new (shape: OccShape, copyGeom: boolean, copyMesh: boolean) => OccCopyBuilder

  // ─── import_step (STEP read + write) ───
  // Emscripten in-memory filesystem (write the STEP bytes here, then ReadFile).
  FS: {
    writeFile(path: string, data: Uint8Array | string): void
    unlink(path: string): void
    readFile(path: string, opts: { encoding: string }): string
    readFile(path: string): Uint8Array
  }
  STEPControl_Reader_1: new () => OccStepReader
  // STEPControl_Writer: serialise a shape to the emscripten FS.
  STEPControl_Writer_1: new () => OccStepWriter
  STEPControl_StepModelType: {
    STEPControl_AsIs: OccEnumValue
  }
  // StlAPI_Writer: serialise a shape to an STL file on the emscripten FS.
  StlAPI_Writer: new () => OccStlWriter
  IFSelect_ReturnStatus: {
    IFSelect_RetDone: OccEnumValue
  }
}

/** A face shape exposes its orientation (FORWARD/REVERSED) via Orientation_1. */
export interface OccOrientedShape extends OccShape {
  Orientation_1(): OccEnumValue
}

/** A shape handle that can flip its orientation (TopoDS_Shape::Reversed). */
export interface OccOrientableShape extends OccShape {
  Reversed(): OccShape
}

/** BRepTools_ReShape: record shape substitutions, then rebuild the ancestors.
 *  Also covers ShapeBuild_ReShape (its subclass, the ShapeFix context). */
export interface OccReShape extends OccDisposable {
  Replace(oldShape: OccShape, newShape: OccShape): void
  Apply(shape: OccShape, until: OccShapeEnumValue): OccShape
}

/** Handle_ShapeBuild_ReShape: get() borrows the fixer's substitution context. */
export interface OccReShapeHandle extends OccDisposable {
  get(): OccReShape | null
}

/** ShapeFix_Shape: the general healer (here: project missing face pcurves). */
export interface OccShapeFixShape extends OccDisposable {
  Perform(progress: OccDisposable): boolean
  Shape(): OccShape
  Context(): OccReShapeHandle
}

/** BRepCheck_Analyzer: whole-shape validity gate. */
export interface OccShapeAnalyzer extends OccDisposable {
  IsValid_2(): boolean
}

/**
 * gp_Trsf: a rigid/scale transform. `Multiply(T)` composes in place (this = this
 * * T), mirroring Python's `combined.Multiply(...)`. SetMirror_3 mirrors across
 * the plane of a gp_Ax2.
 */
export interface OccTrsf extends OccDisposable {
  SetTranslation_1(vec: OccVec): void
  SetRotation_1(axis: OccDisposable, angle: number): void
  SetScale(center: OccPnt, factor: number): void
  SetMirror_3(ax2: OccDisposable): void
  Multiply(other: OccTrsf): void
}

export interface OccTransformBuilder extends OccDisposable {
  Build(): void
  IsDone(): boolean
  Shape(): OccShape
  Modified(s: OccShape): OccListOfShape
  /** The single transformed counterpart of `s`. `Modified()` returns a list
   *  whose `Extent()` this build does not bind, so this is the usable form. */
  ModifiedShape(s: OccShape): OccShape
  IsDeleted(s: OccShape): boolean
}

export interface OccCopyBuilder extends OccDisposable {
  Shape(): OccShape
}

/**
 * An OCC `Handle(...)` as embind hands it back: a smart-pointer wrapper whose
 * `.get()` reaches the object. Not to be confused with `handleTable`'s
 * `OccHandle`, which is our own integer shape slot.
 *
 * Measured (occ/primitivesReal.test.ts, wave 10 D2): `.get()` returns a FRESH
 * embind wrapper per call, so two results are never the same JS object. Each is
 * a borrowed view of a C++ object the handle owns: do not `.delete()` a result
 * (that frees the object out from under the handle, stepIo.ts:189-191); the
 * per-call cost is only a small JS-side wrapper registration.
 */
export interface OccTransientHandle<T> extends OccDisposable {
  get(): T
  IsNull(): boolean
}

/** STEPControl_Reader: read a STEP file from the emscripten FS into a shape. */
export interface OccStepReader extends OccDisposable {
  ReadFile(path: string): OccEnumValue
  TransferRoots(): number
  OneShape(): OccShape
  // The work session, the way through to the transfer reader.
  WS(): OccTransientHandle<OccWorkSession>
  // The parsed STEP model, which owns the entity -> `#N` labels.
  Model(): OccTransientHandle<OccInterfaceModel>
}

/** XSControl_WorkSession: only the transfer reader is used here. */
export interface OccWorkSession {
  TransferReader(): OccTransientHandle<OccTransferReader>
}

/**
 * XSControl_TransferReader: the file entity <-> result shape map built during
 * `TransferRoots`. It knows ONLY the shapes the transfer itself produced -- a
 * later `BRepBuilderAPI_Transform` copy is invisible to it.
 *
 * Its convenience `EntityFromShapeResult(shape, -1)` is deliberately NOT
 * declared here: it answers by scanning the whole transfer map, so calling it
 * per face is O(faces x map) and cost ~10 s on a 1200-face import. Walk
 * `TransientProcess()` once instead.
 */
export interface OccTransferReader {
  TransientProcess(): OccTransientHandle<OccTransientProcess>
}

/**
 * Transfer_TransientProcess: the transfer map itself, as parallel 1-based
 * arrays -- `Mapped(i)` is the source file entity, `MapItem(i)` the binder
 * holding what it produced.
 */
export interface OccTransientProcess {
  NbMapped(): number
  Mapped(index: number): OccTransientHandle<unknown>
  MapItem(index: number): OccTransientHandle<OccTransferBinder>
}

/**
 * One entry of the transfer map. embind hands back the most-derived registered
 * type, so a shape binder's `Result()` yields a `TopoDS_Shape` while other
 * binder kinds yield something else -- narrow on the RESULT, not on the binder.
 */
export interface OccTransferBinder extends OccDisposable {
  Result?: () => OccMaybeShape
}

/** Narrowing shim: only a shape carries `ShapeType`. */
export interface OccMaybeShape extends OccDisposable {
  ShapeType?: () => OccEnumValue
}

/** Interface_InterfaceModel: entity -> the `#N` id the file wrote it under. */
export interface OccInterfaceModel {
  IdentLabel(entity: OccTransientHandle<unknown>): number
}

/** STEPControl_Writer: serialise a shape to a STEP file on the emscripten FS. */
export interface OccStepWriter extends OccDisposable {
  Transfer(shape: OccShape, mode: OccEnumValue, compound: boolean): OccEnumValue
  Write(path: string): OccEnumValue
}

/** StlAPI_Writer: serialise a shape to an STL file on the emscripten FS. */
export interface OccStlWriter extends OccDisposable {
  Write(shape: OccShape, path: string): boolean
}
