// Port of the slices of oversolved/kernel/solver_constants.py the TS kernel
// needs (topology tolerances + builtin planes/origin for the global repository).
// Kept narrow on purpose; grows as further phases need more constants.

export const TOL_LOOP_CLOSURE = 1e-6
export const TOL_NEAR_ZERO_AREA = 1e-12
export const TOL_TOPOLOGY_EPS = 1e-9
export const TOL_TOPOLOGY_MERGE = 1e-7
export const TOL_TOPOLOGY_SPLIT = 1e-7

// Arc tessellation density (mirrors solver_constants._ARC_SEGMENTS): the number
// of straight segments a full 360deg arc is sampled into for profile loops.
export const ARC_SEGMENTS = 32

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
 * Builtin planes as feature-result entries (port of `_BUILTIN_PLANE_RESULTS`).
 * `build()` merges these into the result dict so a doc's planes are addressable,
 * mirroring `builder.py`. The `type` key is dropped, matching Python.
 */
export const BUILTIN_PLANE_RESULTS: Record<string, Record<string, unknown>> = Object.fromEntries(
  Object.entries(BUILTIN_PLANES).map(([name, plane]) => {
    const { type: _type, ...rest } = plane as Record<string, unknown>
    return [name, { status: "ok", plane: rest }]
  }),
)
