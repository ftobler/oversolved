_FRONT_PLANE: dict = {
    "type": "plane",
    "origin": [0, 0, 0],
    "x_axis": [1, 0, 0],
    "y_axis": [0, 1, 0],
    "normal": [0, 0, 1],
}

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

# Above this threshold the system transitions from well-constrained to overconstrained (conflicting constraints).
LOSS_THRESHOLD = 1e-4
RANK_TOL = 1e-6  # tolerance for numerical rank computation
# when rank is within this many of the DOF boundary, log a diagnostic warning
RANK_BOUNDARY_TOL = 1

ORIGIN_ID = "_origin"
ORIGIN_FIX_ID = "__builtin_origin_fix__"

_BUILTIN_PLANES: dict = {
    "builtin_plane_front": _FRONT_PLANE,
    "builtin_plane_top": {
        "type": "plane",
        "origin": [0, 0, 0],
        "x_axis": [1, 0, 0],
        "y_axis": [0, 0, -1],
        "normal": [0, 1, 0],
    },
    "builtin_plane_right": {
        "type": "plane",
        "origin": [0, 0, 0],
        "x_axis": [0, 0, -1],
        "y_axis": [0, 1, 0],
        "normal": [1, 0, 0],
    },
}

_PROJECTED_KINDS = frozenset(
    {"projected_line", "projected_circle", "projected_arc", "projected_point"}
)

_FACE_TYPES = frozenset({"face", "flatface", "cylinderface"})
_PLANE_TYPES = frozenset({"plane", "face", "flatface"})
_POINT_TYPES = frozenset({"point", "vertex"})

_ARC_SEGMENTS = 32  # tessellation resolution for arc edges in profiles

_BUILTIN_PLANE_RESULTS: dict[str, dict] = {
    name: {
        "status": "ok",
        "plane": {k: v for k, v in plane.items() if k != "type"},
    }
    for name, plane in _BUILTIN_PLANES.items()
}
