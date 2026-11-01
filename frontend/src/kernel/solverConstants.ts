// Kept narrow on purpose.

export const TOL_LOOP_CLOSURE = 1e-6
export const TOL_NEAR_ZERO_AREA = 1e-12
export const TOL_TOPOLOGY_EPS = 1e-9
// World-space vertex merge: two area-builder vertices closer than this are one.
// Must not be tighter than the solver's coincidence residual, else a line
// endpoint constrained onto a curve and the curve/line intersection computed
// there land on distinct vertices and the slice fails to close. The solver
// routinely converges a coincidence to ~1e-6 (bug report sketch_area_building:
// a venn chord whose endpoints sit on the circle/circle intersections landed
// 1.03e-6 away, just past a 1e-6 merge, tearing the planar graph into 1 face
// instead of 4), so this sits an order of magnitude above that residual while
// staying far below any real feature separation. Mirrored in
// sketch-solver/src/topology/mod.rs.
export const TOL_TOPOLOGY_MERGE = 1e-5
export const TOL_TOPOLOGY_SPLIT = 1e-7
// Move-face tangent tolerance: the angular tolerance handed to
// BRepOffset_Analyse. An edge whose dihedral angle is within this of flat is a
// Tangent join (a fillet boundary), and move-face refuses it: the extended
// neighbour surface has no meaningful continuation past the tangency. Radians,
// measured off the surface normals, so it is scale-free.
export const TOL_MOVE_FACE_TANGENT = 1e-3
// OCC's Precision::Confusion(), the tolerance BRepBuilderAPI_MakeWire uses to
// decide whether two edge endpoints are the same point. It is not ours to
// choose: it is compiled into opencascade.js@1.1.1 (OCCT 7.4.0p1). Mirrored here so
// the tolerance ladder the profile handoff depends on --
// OCC_CONFUSION < TOL_LOOP_CLOSURE <= TOL_TOPOLOGY_MERGE -- is stated in one
// place and testable (solverConstants.test.ts). Deliberately NOT a TOL_* name:
// the Rust mirror test parses `TOL_*` out of sketch-solver and asserts an exact
// count, and this constant has no Rust twin.
export const OCC_CONFUSION = 1e-7

// How long a kernel host waits for the next feature progress mark
// (featureProgress.ts) before it presumes the solve stuck, kills its worker and
// answers with a timeout naming the feature. It bounds the gap between marks,
// not the whole call, so a long script of quick features is never cut off.
// The MCP kernel host arms it (drive/kernelHost.ts); the browser solver client
// keeps its watchdog off and leaves the call to the user's cancel button.
export const SOLVE_STALL_BUDGET_MS = 30_000

// ─── Feature tolerance rungs (lr4-tolerance-ladder) ───

// The angular rung select's direction predicates test, stated as the sine
// between the test axis and the candidate's unit direction: parallel matches
// when |cross| is under it, perpendicular when |dot| is (the cosine of a
// deviation from a right angle is that deviation's sine). 1e-6 rad is about
// 5.7e-5 deg: it absorbs the f64 noise of an exact solve and still rejects a
// visibly nearby face. The parallel clause used to test 1 - 1e-6 against the
// dot instead, which admits sines up to ~1.4e-3, ~1400x looser than the
// perpendicular clause beside it; both clauses now compare against this sine.
export const TOL_SELECT_DIRECTION = 1e-6

// Surface identity: a point lies on an analytic surface, or two coaxial
// analytic surfaces are the same surface (radius, apex, centre and plane
// offset compare as world distances), when they agree within this. It sits on
// the loop-closure rung of the ladder: OCC_CONFUSION < TOL_SURFACE_IDENTITY =
// TOL_LOOP_CLOSURE <= TOL_TOPOLOGY_MERGE. The move-face and offset modules
// each carried a private copy of this rung (SURFACE_TOL, PLANE_TOL, UV_TOL,
// TOOL_FACE_TOL, SHAPE_TOL); they all read this one now. The move-face
// curved-region classifier also reads it as parameter-space slack, where the
// u and v dimensions are angles: there it stands for 1e-6 of turn, not a
// world distance.
export const TOL_SURFACE_IDENTITY = 1e-6

// The angular companion of the surface-identity rung: the unit axes of two
// analytic surfaces must be this parallel before the surfaces count as the
// same one. Far tighter than select's rung because these axes come out of an
// analytic solve exact in f64; the tolerance absorbs arithmetic noise only,
// never authoring slack.
export const TOL_SURFACE_PARALLEL = 1e-9

// Length slack: how far past exact a comparison between two authored lengths
// reads as equal: bores just touching, a fillet exactly the shell thickness,
// a profile exactly one helix pitch tall, a probe of exactly zero length. Two
// orders of magnitude under OCC_CONFUSION, so it absorbs f64 noise on world
// coordinates without ever accepting a real separation.
export const TOL_LENGTH_SLACK = 1e-9

// Volume budgets, each a fraction of the volume it judges. OCC integrates a
// solid's volume with error that scales with the solid, so an absolute
// epsilon decides a 1000x part on a different footing than the same part at
// scale 1; a fraction travels with it. Degenerate (at or under it a solid
// reads as empty: a split half, a kept-everything plane miss, an offset that
// did not move the tool) and sum (closes the split additivity check) sit one
// rung apart, like the length rungs above them do.
export const TOL_VOLUME_DEGENERATE = 1e-9
export const TOL_VOLUME_SUM = 1e-6

// The lattice the preview-edge overlay keys its sampled points to
// (components/Geometry3D/PreviewEdgeOverlay.tsx): a sampled point moved by less
// than a cell is the same point, which is what lets two passes over one curve
// recognise each other; the overlay probes the 27 neighbour cells the way
// picking's mark position index does (picking/markPosition.ts), so samples that
// straddle a cell boundary are still one point. Level with TOL_MOVE_FACE_TANGENT
// it is the coarsest rung the ladder names, because it judges a rendering
// coincidence and not geometry. The lattice is fixed in world units on purpose:
// it quantizes float32 tessellation, whose own step outruns a fixed cell above
// roughly 1e4 model units (feature/backlog.md).
export const TOL_PREVIEW_CELL = 1e-3

export const BUILTIN_PLANES: Record<string, Record<string, unknown>> = {
  builtin_plane_front: {
    origin: [0, 0, 0],
    x_axis: [1, 0, 0],
    y_axis: [0, 1, 0],
    normal: [0, 0, 1],
    type: "plane",
  },
  builtin_plane_top: {
    origin: [0, 0, 0],
    x_axis: [1, 0, 0],
    y_axis: [0, 0, -1],
    normal: [0, 1, 0],
    type: "plane",
  },
  builtin_plane_right: {
    origin: [0, 0, 0],
    x_axis: [0, 0, -1],
    y_axis: [0, 1, 0],
    normal: [1, 0, 0],
    type: "plane",
  },
}

/**
 * Builtin planes as feature-result entries. `build()` merges these into the
 * result dict so a doc's planes are addressable. The `type` key is dropped.
 */
export const BUILTIN_PLANE_RESULTS: Record<string, Record<string, unknown>> = Object.fromEntries(
  Object.entries(BUILTIN_PLANES).map(([name, plane]) => {
    const { type: _type, ...rest } = plane as Record<string, unknown>
    return [name, { status: "ok", plane: rest }]
  }),
)

// ─── Plane/point type helpers ───

export const PLANE_TYPES = new Set(["plane", "face", "flatface"])
export const POINT_TYPES = new Set(["point", "vertex"])

const BARE_ID_MAP: Record<string, string> = {
  Top: "builtin_plane_top",
  Front: "builtin_plane_front",
  Right: "builtin_plane_right",
}

export function isPlaneType(obj: Record<string, unknown>): boolean {
  return PLANE_TYPES.has(obj["type"] as string)
}

export function isPointType(obj: Record<string, unknown>): boolean {
  return POINT_TYPES.has(obj["type"] as string)
}

export function resolveBarePlaneId(name: string): string | null {
  return BARE_ID_MAP[name] ?? null
}
