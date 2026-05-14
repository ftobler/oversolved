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

_BUILTIN_PLANE_RESULTS: dict[str, dict] = {
    name: {
        "status": "ok",
        "plane": {k: v for k, v in plane.items() if k != "type"},
    }
    for name, plane in _BUILTIN_PLANES.items()
}
