from oversolved.kernel.types3d import FRONT, TOP, RIGHT

_FRONT_PLANE: dict = {**FRONT.to_dict(), "type": "plane"}

ENTITY_SIZES: dict[str, int] = {
    "line": 4,
    "circle": 3,
    "arc": 5,
    "point": 2,
    "projected_line": 4,
    "projected_circle": 3,
    "projected_arc": 5,
    "projected_point": 2,
}

LOSS_THRESHOLD = 1e-4
RANK_TOL = 1e-6
RANK_BOUNDARY_TOL = 1

# ─── Geometry tolerances ───
TOL_LOOP_CLOSURE = 1e-6     # max 2D gap to consider a profile-loop edge chain closed
TOL_NEAR_ZERO_AREA = 1e-12  # area below which a polygon is considered degenerate
TOL_MESH_NORMAL = 1e-5      # normal deviation threshold in mesh validation

# ─── Topology tolerances ───
TOL_TOPOLOGY_EPS = 1e-9     # point coincidence in the half-edge graph
TOL_TOPOLOGY_MERGE = 1e-7   # vertex merge distance (must exceed TOL_TOPOLOGY_EPS)
TOL_TOPOLOGY_SPLIT = 1e-7   # parametric split dedup tolerance

ORIGIN_ID = "_origin"
ORIGIN_FIX_ID = "__builtin_origin_fix__"

_BUILTIN_PLANES: dict = {
    "builtin_plane_front": _FRONT_PLANE,
    "builtin_plane_top": {**TOP.to_dict(), "type": "plane"},
    "builtin_plane_right": {**RIGHT.to_dict(), "type": "plane"},
}

_PROJECTED_KINDS = frozenset(
    {"projected_line", "projected_circle", "projected_arc", "projected_point"}
)

_FACE_TYPES = frozenset({"face", "flatface", "cylinderface"})
_PLANE_TYPES = frozenset({"plane", "face", "flatface"})
_POINT_TYPES = frozenset({"point", "vertex"})

_ARC_SEGMENTS = 32

_KNOWN_FEATURE_KINDS = frozenset({
    "sketch", "plane", "extrude", "revolve",
    "import_step", "fillet", "chamfer",
    "array", "boolean", "delete_body",
    "hole", "transform", "mirror",
})

_BUILTIN_PLANE_RESULTS: dict[str, dict] = {
    name: {
        "status": "ok",
        "plane": {k: v for k, v in plane.items() if k != "type"},
    }
    for name, plane in _BUILTIN_PLANES.items()
}
