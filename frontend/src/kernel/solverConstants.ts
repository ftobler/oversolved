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

export const FRONT_PLANE = BUILTIN_PLANES["builtin_plane_front"]

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
