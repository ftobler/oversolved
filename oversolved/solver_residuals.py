import logging
import numpy as np
from oversolved.solver_constants import ENTITY_SIZES

logger = logging.getLogger(__name__)


def _build_residuals_fn(constraints, entities, entity_offsets, x0):
    """Build a residuals function for least_squares optimization.

    Returns (residuals_func, line_circle_coincident) where residuals_func
    takes a parameter vector x and returns the residual vector.
    """
    def get_params(x, eid):
        off = entity_offsets[eid]
        size = ENTITY_SIZES[entities[eid]["kind"]]
        return x[off: off + size]

    def get_point(x, ref):
        if "external_xy" in ref:
            return np.array(ref["external_xy"], dtype=np.float64)
        eid = ref["entity"]
        ep = get_params(x, eid)
        kind = entities[eid]["kind"]
        point = ref.get("point", "start")
        if kind in ("line", "projected_line"):
            return ep[2:4] if point == "end" else ep[0:2]
        elif kind in ("circle", "projected_circle"):
            return ep[0:2]
        elif kind in ("arc", "projected_arc"):
            cx, cy, r = ep[0], ep[1], ep[2]
            a_deg = ep[3] if point != "end" else ep[4]
            return np.array(
                [cx + r * np.cos(np.radians(a_deg)), cy + r * np.sin(np.radians(a_deg))]
            )
        elif kind in ("point", "projected_point"):
            return ep[0:2]
        raise ValueError(f"Unknown kind: {kind!r}")

    def _radius_dir(x, arc_eid, arc_ref, contact_ep):
        ep = get_params(x, arc_eid)
        if entities[arc_eid]["kind"] == "circle":
            rv = contact_ep - ep[0:2]
            rn = np.linalg.norm(rv)
            return rv / rn if rn > 1e-10 else np.array([1.0, 0.0])
        arc_pt = arc_ref.get("point", "start")
        a_deg = ep[3] if arc_pt != "end" else ep[4]
        return np.array([np.cos(np.radians(a_deg)), np.sin(np.radians(a_deg))])

    # Pre-compute (line_eid, circle_eid) -> endpoint ("start"/"end") for coincident
    # constraints that pin a specific line endpoint to a circle.
    line_circle_coincident = {}
    for _c in constraints:
        if _c.get("kind") == "coincident" and "point" in _c.get("a", {}):
            _a, _b = _c["a"], _c["b"]
            _a_eid = _a.get("entity")
            _b_eid = _b.get("entity")
            if (
                _a_eid
                and _b_eid
                and entities.get(_a_eid, {}).get("kind") == "line"
                and entities.get(_b_eid, {}).get("kind") == "circle"
                and "point" not in _b
            ):
                line_circle_coincident[(_a_eid, _b_eid)] = _a.get("point", "start")

    def residuals(x, clist=None):
        r = []
        for c in clist if clist is not None else constraints:
            kind = c["kind"]
            if kind == "horizontal":
                if "a" in c:
                    pa = get_point(x, c["a"])
                    pb = get_point(x, c["b"])
                    r.append(pa[1] - pb[1])
                else:
                    ep = get_params(x, c["target"]["entity"])
                    r.append(ep[3] - ep[1])
            elif kind == "vertical":
                if "a" in c:
                    pa = get_point(x, c["a"])
                    pb = get_point(x, c["b"])
                    r.append(pa[0] - pb[0])
                else:
                    ep = get_params(x, c["target"]["entity"])
                    r.append(ep[2] - ep[0])
            elif kind == "length":
                ep = get_params(x, c["target"]["entity"])
                dx, dy = ep[2] - ep[0], ep[3] - ep[1]
                r.append(np.sqrt(dx**2 + dy**2) - c["value"])
            elif kind == "radius":
                ep = get_params(x, c["target"]["entity"])
                r.append(ep[2] - c["value"])
            elif kind == "diameter":
                ep = get_params(x, c["target"]["entity"])
                r.append(2 * ep[2] - c["value"])
            elif kind == "line_distance":
                if c["a"]["entity"] == c["b"]["entity"]:
                    raise ValueError(
                        f"line_distance constraint '{c['id']}': "
                        "a and b cannot reference the same entity"
                    )
                ep_a = get_params(x, c["a"]["entity"])
                pb = get_point(x, c["b"])
                dx, dy = ep_a[2] - ep_a[0], ep_a[3] - ep_a[1]
                n = np.sqrt(dx**2 + dy**2)
                nx, ny = (-dy / n, dx / n) if n > 0 else (0.0, 1.0)
                vx = pb[0] - ep_a[0]
                vy = pb[1] - ep_a[1]
                r.append(vx * nx + vy * ny - c["value"])
            elif kind == "coincident":
                a_ref = c["a"]
                b_ref = c["b"]
                a_external = "external_xy" in a_ref
                b_external = "external_xy" in b_ref
                a_eid = None if a_external else a_ref["entity"]
                b_eid = None if b_external else b_ref["entity"]
                a_kind = None if a_external else entities[a_eid]["kind"]
                b_kind = None if b_external else entities[b_eid]["kind"]
                if (
                    not a_external
                    and not b_external
                    and "point" not in a_ref
                    and "point" not in b_ref
                    and a_kind == "line"
                    and b_kind == "line"
                ):
                    ea = get_params(x, a_eid)
                    eb = get_params(x, b_eid)
                    da = ea[2:4] - ea[0:2]
                    db = eb[2:4] - eb[0:2]
                    r.append(da[0] * db[1] - da[1] * db[0])
                    n = np.sqrt(da[0] ** 2 + da[1] ** 2)
                    nx, ny = (-da[1] / n, da[0] / n) if n > 0 else (0.0, 1.0)
                    r.append((eb[0] - ea[0]) * nx + (eb[1] - ea[1]) * ny)
                elif not b_external and "point" not in b_ref and b_kind == "line":
                    pa = get_point(x, a_ref)
                    ep_b = get_params(x, b_eid)
                    dx, dy = ep_b[2] - ep_b[0], ep_b[3] - ep_b[1]
                    n = np.sqrt(dx**2 + dy**2)
                    nx, ny = (-dy / n, dx / n) if n > 0 else (0.0, 1.0)
                    r.append((pa[0] - ep_b[0]) * nx + (pa[1] - ep_b[1]) * ny)
                elif (
                    not b_external
                    and "point" not in b_ref
                    and b_kind in ("circle", "arc")
                ):
                    pa = get_point(x, a_ref)
                    ep_b = get_params(x, b_eid)
                    dist = np.sqrt((pa[0] - ep_b[0]) ** 2 + (pa[1] - ep_b[1]) ** 2)
                    r.append(dist - ep_b[2])
                else:
                    pa = get_point(x, a_ref)
                    pb = get_point(x, b_ref)
                    r.append(pa[0] - pb[0])
                    r.append(pa[1] - pb[1])
            elif kind == "normal":
                ea_id = c["a"]["entity"]
                eb_id = c["b"]["entity"]
                ea_kind = entities[ea_id]["kind"]
                eb_kind = entities[eb_id]["kind"]
                if ea_kind == "line" and eb_kind == "line":
                    ea = get_params(x, ea_id)
                    eb = get_params(x, eb_id)
                    da = ea[2:4] - ea[0:2]
                    db = eb[2:4] - eb[0:2]
                    r.append(np.dot(da, db))
                else:
                    line_ref = c["a"] if ea_kind == "line" else c["b"]
                    arc_ref = c["b"] if ea_kind == "line" else c["a"]
                    line_ep = get_params(x, line_ref["entity"])
                    line_dir = line_ep[2:4] - line_ep[0:2]
                    contact = line_ep[2:4]
                    radius_dir = _radius_dir(x, arc_ref["entity"], arc_ref, contact)
                    r.append(line_dir[0] * radius_dir[1] - line_dir[1] * radius_dir[0])
            elif kind == "parallel":
                ea = get_params(x, c["a"]["entity"])
                eb = get_params(x, c["b"]["entity"])
                da = ea[2:4] - ea[0:2]
                db = eb[2:4] - eb[0:2]
                r.append(da[0] * db[1] - da[1] * db[0])
            elif kind == "angle":
                ea = get_params(x, c["a"]["entity"])
                eb = get_params(x, c["b"]["entity"])
                da = ea[2:4] - ea[0:2]
                db = eb[2:4] - eb[0:2]
                cos_val = np.dot(da, db) / (np.linalg.norm(da) * np.linalg.norm(db))
                r.append(cos_val - np.cos(np.radians(c["value"])))
            elif kind == "tangent":
                if "line" in c and "arc" in c:
                    line_ref, arc_ref = c["line"], c["arc"]
                else:
                    ea_id, eb_id = c["a"]["entity"], c["b"]["entity"]
                    if entities[ea_id]["kind"] == "line":
                        line_ref, arc_ref = c["a"], c["b"]
                    else:
                        line_ref, arc_ref = c["b"], c["a"]
                line_ep = get_params(x, line_ref["entity"])
                arc_ep = get_params(x, arc_ref["entity"])
                line_dir = line_ep[2:4] - line_ep[0:2]
                _eps = 0.01
                line_dir = line_dir / np.sqrt(np.dot(line_dir, line_dir) + _eps * _eps)
                if entities[arc_ref["entity"]]["kind"] == "circle":
                    line_eid = line_ref["entity"]
                    arc_eid = arc_ref["entity"]
                    if (line_eid, arc_eid) in line_circle_coincident:
                        pinned_pt = line_circle_coincident[(line_eid, arc_eid)]
                        contact = line_ep[0:2] if pinned_pt == "start" else line_ep[2:4]
                        radius_dir = _radius_dir(x, arc_eid, arc_ref, contact)
                        r.append(np.dot(line_dir, radius_dir))
                    else:
                        contact = line_ep[2:4]
                        radius_dir = _radius_dir(x, arc_ref["entity"], arc_ref, contact)
                        r.append(np.dot(line_dir, radius_dir))
                        dist = np.sqrt(
                            (contact[0] - arc_ep[0]) ** 2
                            + (contact[1] - arc_ep[1]) ** 2
                        )
                        r.append(dist - arc_ep[2])
                else:
                    contact = line_ep[2:4]
                    radius_dir = _radius_dir(x, arc_ref["entity"], arc_ref, contact)
                    r.append(np.dot(line_dir, radius_dir))
            elif kind == "equal_length":
                ea = get_params(x, c["a"]["entity"])
                eb = get_params(x, c["b"]["entity"])
                len_a = np.sqrt((ea[2] - ea[0]) ** 2 + (ea[3] - ea[1]) ** 2)
                len_b = np.sqrt((eb[2] - eb[0]) ** 2 + (eb[3] - eb[1]) ** 2)
                r.append(len_a - len_b)
            elif kind == "point_distance":
                pa = get_point(x, c["a"])
                pb = get_point(x, c["b"])
                dist = np.sqrt((pb[0] - pa[0]) ** 2 + (pb[1] - pa[1]) ** 2)
                r.append(dist - c["value"])
            elif kind == "midpoint":
                if "line" in c:
                    ep = get_params(x, c["line"]["entity"])
                    mid = np.array([(ep[0] + ep[2]) / 2, (ep[1] + ep[3]) / 2])
                else:
                    pa = get_point(x, c["point_a"])
                    pb = get_point(x, c["point_b"])
                    mid = (pa + pb) / 2
                pt = get_point(x, c["point"])
                axis = c.get("axis", "both")
                if axis in ("x", "both"):
                    r.append(pt[0] - mid[0])
                if axis in ("y", "both"):
                    r.append(pt[1] - mid[1])
            elif kind == "concentric":
                ea = get_params(x, c["a"]["entity"])
                eb = get_params(x, c["b"]["entity"])
                r.append(ea[0] - eb[0])
                r.append(ea[1] - eb[1])
            elif kind == "fixed":
                eid = c["target"]["entity"]
                has_point = "point" in c["target"]
                has_xy = "x" in c and "y" in c
                if has_point or has_xy:
                    pt = get_point(x, c["target"])
                    fix_x = c.get("x", float(get_point(x0, c["target"])[0]))
                    fix_y = c.get("y", float(get_point(x0, c["target"])[1]))
                    r.append(pt[0] - fix_x)
                    r.append(pt[1] - fix_y)
                else:
                    off = entity_offsets[eid]
                    size = ENTITY_SIZES[entities[eid]["kind"]]
                    for i in range(size):
                        r.append(x[off + i] - x0[off + i])
            else:
                raise ValueError(f"Unknown constraint kind: {kind!r}")
        return np.array(r) if r else np.zeros(0)

    return residuals, line_circle_coincident
