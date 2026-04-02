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
            # Arc: [cx, cy, r, a_start, a_end], compute start point from angle
            cx, cy, r, a_start = self._data[0], self._data[1], self._data[2], self._data[3]
            return [cx + r * math.cos(math.radians(a_start)), cy + r * math.sin(math.radians(a_start))]
        raise AttributeError(f"start not available for {self._kind}")

    @property
    def end(self):
        if self._kind == "line":
            return list(self._data[2:4])
        elif self._kind == "arc":
            # Arc: [cx, cy, r, a_start, a_end], compute end point from angle
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
                # Try to access the property; if it raises AttributeError, it's not available
                getattr(self, key)
                return True
            except AttributeError:
                return False
        return False

    def get(self, key):
        """Support .get("construction") for construction flag."""
        if key == "construction":
            # Construction flag is not in the array; would need to be passed separately
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
