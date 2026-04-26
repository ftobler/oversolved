"""Shared test utilities for solver tests."""

import math
import textwrap


TOL = 1e-5
ATOL = 1e-3  # angular / normalized-dot-product tolerance


class Geom:
    """Wrapper to make flat array geometry readable in tests.

    Converts geometry arrays to accessible properties:
    - line [x1,y1,x2,y2] -> .start, .end
    - circle [cx,cy,r] -> .center, .radius
    - arc [cx,cy,r,a0,a1] -> .center, .radius, .angle_start, .angle_end, .start, .end
    - point [x,y] -> .x, .y
    """

    def __init__(self, geom_dict, entity_kind):
        self._data = geom_dict
        self._kind = entity_kind

    def __getitem__(self, key):
        """Support dict-style and slice access: .["start"], ["radius"], [0:2], etc."""
        if isinstance(key, slice):
            return self._data[key]
        elif isinstance(key, int):
            return self._data[key]
        elif key == "start":
            return self.start
        elif key == "end":
            return self.end
        elif key == "center":
            return self.center
        elif key == "radius":
            return self.radius
        elif key == "angle_start":
            return self.angle_start
        elif key == "angle_end":
            return self.angle_end
        elif key == "x":
            return self.x
        elif key == "y":
            return self.y
        else:
            raise KeyError(f"Unknown key: {key}")

    @property
    def start(self):
        if self._kind == "line":
            return list(self._data[0:2])
        elif self._kind == "arc":
            cx, cy, r, a_start = self._data[0], self._data[1], self._data[2], self._data[3]
            return [cx + r * math.cos(math.radians(a_start)), cy + r * math.sin(math.radians(a_start))]
        raise AttributeError(f"start not available for {self._kind}")

    @property
    def end(self):
        if self._kind == "line":
            return list(self._data[2:4])
        elif self._kind == "arc":
            cx, cy, r, a_end = self._data[0], self._data[1], self._data[2], self._data[4]
            return [cx + r * math.cos(math.radians(a_end)), cy + r * math.sin(math.radians(a_end))]
        raise AttributeError(f"end not available for {self._kind}")

    @property
    def center(self):
        if self._kind in ("circle", "arc"):
            return list(self._data[0:2])
        raise AttributeError(f"center not available for {self._kind}")

    @property
    def radius(self):
        if self._kind in ("circle", "arc"):
            return self._data[2]
        raise AttributeError(f"radius not available for {self._kind}")

    @property
    def angle_start(self):
        if self._kind == "arc":
            return self._data[3]
        raise AttributeError(f"angle_start not available for {self._kind}")

    @property
    def angle_end(self):
        if self._kind == "arc":
            return self._data[4]
        raise AttributeError(f"angle_end not available for {self._kind}")

    @property
    def x(self):
        if self._kind == "point":
            return self._data[0]
        raise AttributeError(f"x not available for {self._kind}")

    @property
    def y(self):
        if self._kind == "point":
            return self._data[1]
        raise AttributeError(f"y not available for {self._kind}")

    def __contains__(self, key):
        """Support 'key' in geom checks."""
        if key in ("start", "end", "center", "radius", "angle_start", "angle_end", "x", "y"):
            try:
                getattr(self, key)
                return True
            except AttributeError:
                return False
        return False

    def get(self, key):
        """Support .get("construction") for construction flag."""
        if key == "construction":
            return None
        raise AttributeError(f"get({key}) not supported")


def length(a, b):
    return math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2)


def is_tangent(line_s, line_e, arc_center, arc_pt):
    """Normalized dot product of line direction and radius vector; should be ~0 for tangency."""
    ld = (line_e[0] - line_s[0], line_e[1] - line_s[1])
    rv = (arc_pt[0] - arc_center[0], arc_pt[1] - arc_center[1])
    dot = ld[0] * rv[0] + ld[1] * rv[1]
    return abs(dot) / (length(line_s, line_e) * length(arc_center, arc_pt))


def angle_between(a_s, a_e, b_s, b_e):
    da = (a_e[0] - a_s[0], a_e[1] - a_s[1])
    db = (b_e[0] - b_s[0], b_e[1] - b_s[1])
    cos = (da[0] * db[0] + da[1] * db[1]) / (length(a_s, a_e) * length(b_s, b_e))
    return math.degrees(math.acos(max(-1.0, min(1.0, cos))))


def to_geom(geom_flat, entities):
    """Convert flat array geometry to readable dict format.

    Entities should be a list of {id, kind, ...} dicts from the YAML.
    Returns {entity_id: Geom wrapper object}
    """
    entities_dict = {e["id"]: e for e in entities}
    result = {}
    for eid, params in geom_flat.items():
        if eid in entities_dict:
            result[eid] = Geom(params, entities_dict[eid]["kind"])
    return result


def minimal_sketch_yaml(plane):
    """Return a minimal sketch YAML string with the given plane query (or None)."""
    plane_line = f'            plane: "{plane}"\n' if plane is not None else ''
    return textwrap.dedent(f"""\
        version: 1
        kind: part
        features:
          - id: sketch_1
            kind: sketch
{plane_line}            entities: []
            constraints: []
    """)


def rect_sketch_spec(
    w: float = 10.0,
    h: float = 10.0,
    sketch_id: str = 'sk1',
    plane: str = '@builtin_plane_front',
) -> dict:
    """Fully-constrained rectangle sketch spec (dict, not YAML string).

    Entities: bottom, right, top, left (lines).
    Constraints: 4 coincident (corners), horizontal bottom+top,
    vertical left+right, length bottom (=w), length left (=h).
    Origin is at [0,0]; rectangle spans [0,w] x [0,h].
    """
    return {
        'id': sketch_id,
        'kind': 'sketch',
        'label': 'Rectangle',
        'plane': plane,
        'entities': [
            {'id': 'bottom', 'kind': 'line'},
            {'id': 'right', 'kind': 'line'},
            {'id': 'top', 'kind': 'line'},
            {'id': 'left', 'kind': 'line'},
        ],
        'initial': {
            'bottom': [0, 0, w, 0],
            'right': [w, 0, w, h],
            'top': [w, h, 0, h],
            'left': [0, h, 0, 0],
        },
        'constraints': [
            {'id': 'c1', 'kind': 'coincident', 'a': {'entity': 'bottom', 'point': 'end'}, 'b': {'entity': 'right', 'point': 'start'}},
            {'id': 'c2', 'kind': 'coincident', 'a': {'entity': 'right', 'point': 'end'}, 'b': {'entity': 'top', 'point': 'start'}},
            {'id': 'c3', 'kind': 'coincident', 'a': {'entity': 'top', 'point': 'end'}, 'b': {'entity': 'left', 'point': 'start'}},
            {'id': 'c4', 'kind': 'coincident', 'a': {'entity': 'left', 'point': 'end'}, 'b': {'entity': 'bottom', 'point': 'start'}},
            {'id': 'c5', 'kind': 'horizontal', 'target': {'entity': 'bottom'}},
            {'id': 'c6', 'kind': 'horizontal', 'target': {'entity': 'top'}},
            {'id': 'c7', 'kind': 'vertical', 'target': {'entity': 'right'}},
            {'id': 'c8', 'kind': 'vertical', 'target': {'entity': 'left'}},
            {'id': 'c9', 'kind': 'length', 'target': {'entity': 'bottom'}, 'value': w},
            {'id': 'c10', 'kind': 'length', 'target': {'entity': 'left'}, 'value': h},
        ],
    }


def extrude_spec(
    sketch_id: str,
    extrude_id: str,
    distance: float,
    direction: str = 'normal',
    operation: str = 'add',
) -> dict:
    """Single extrude feature dict."""
    return {
        'id': extrude_id,
        'kind': 'extrude',
        'label': 'Extrude',
        'sketch': '$' + sketch_id,
        'distance': distance,
        'direction': direction,
        'operation': operation,
    }


def box_extrude_spec(
    w: float = 5.0,
    h: float = 5.0,
    d: float = 5.0,
    sketch_id: str = 'sk1',
    extrude_id: str = 'extrude1',
) -> dict:
    """Complete spec: one fully-constrained rect sketch + one extrude to a box.

    Returns a dict with 'features' containing the sketch and extrude.
    """
    sk = rect_sketch_spec(w, h, sketch_id)
    ex = extrude_spec(sketch_id, extrude_id, d)
    return {'features': [sk, ex]}


def full_rect_extrude_spec(
    w: float = 10.0,
    h: float = 10.0,
    d: float = 5.0,
    direction: str = 'normal',
) -> dict:
    """Complete spec: one fully-constrained rect sketch + one extrude."""
    sk = rect_sketch_spec(w, h)
    ex = extrude_spec('sk1', 'ex1', d, direction)
    return {'features': [sk, ex]}


def assert_mesh_valid(mesh: dict) -> None:
    """Assert structural invariants for any mesh dict."""
    verts = mesh['vertices']
    faces = mesh['faces']
    normals = mesh['normals']
    n = len(verts)

    assert n > 0, "mesh has no vertices"
    assert len(faces) > 0, "mesh has no faces"
    assert len(normals) == len(faces), (
        f"normals count {len(normals)} != faces count {len(faces)}"
    )

    for i, (a, b, c) in enumerate(faces):
        assert 0 <= a < n, f"face {i}: index a={a} out of range [0, {n})"
        assert 0 <= b < n, f"face {i}: index b={b} out of range [0, {n})"
        assert 0 <= c < n, f"face {i}: index c={c} out of range [0, {n})"
        assert a != b and b != c and a != c, f"face {i} is degenerate: ({a},{b},{c})"

    for i, n_vec in enumerate(normals):
        mag = math.sqrt(sum(x*x for x in n_vec))
        assert abs(mag - 1.0) < 1e-5, f"normal {i} not unit length: mag={mag}"


def assert_mesh_bbox(mesh: dict, x_range, y_range, z_range, tol: float = 0.1) -> None:
    """Assert mesh bounding box matches expected ranges within tolerance."""
    xs = [v[0] for v in mesh['vertices']]
    ys = [v[1] for v in mesh['vertices']]
    zs = [v[2] for v in mesh['vertices']]

    def check(vals, lo, hi, axis):
        actual_lo, actual_hi = min(vals), max(vals)
        assert actual_lo >= lo - tol, f"{axis} min={actual_lo:.4f} expected >= {lo}"
        assert actual_hi <= hi + tol, f"{axis} max={actual_hi:.4f} expected <= {hi}"
        assert actual_lo <= lo + tol, f"{axis} min={actual_lo:.4f} not close to {lo}"
        assert actual_hi >= hi - tol, f"{axis} max={actual_hi:.4f} not close to {hi}"

    check(xs, x_range[0], x_range[1], 'x')
    check(ys, y_range[0], y_range[1], 'y')
    check(zs, z_range[0], z_range[1], 'z')


def point_sketch_spec(points, sketch_id='pts', plane='@builtin_plane_front'):
    """Sketch containing only point entities at given [(x,y), ...] coordinates."""
    entities = [{"id": f"pt{i}", "kind": "point"} for i, _ in enumerate(points)]
    initial = {f"pt{i}": list(p) for i, p in enumerate(points)}
    return {
        "id": sketch_id, "kind": "sketch", "plane": plane,
        "entities": entities, "initial": initial, "constraints": [],
    }


def hole_spec(sketch_id, hole_id, diameter=10.0, depth=20.0,
              depth_mode='blind', direction='normal', target=None):
    h = {"sketch": "@" + sketch_id, "diameter": diameter,
         "depth": depth, "depth_mode": depth_mode, "direction": direction}
    if target:
        h["target"] = target
    return {"id": hole_id, "kind": "hole", "hole": h}
