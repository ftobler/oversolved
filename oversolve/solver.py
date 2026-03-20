import math
import time
import yaml
import numpy as np
from scipy.optimize import least_squares


ENTITY_SIZES = {
    "line_segment": 4,  # x1, y1, x2, y2
    "circle":       3,  # cx, cy, r
    "arc":          5,  # cx, cy, r, a_start_deg, a_end_deg
    "point":        2,  # x, y
}

LOSS_THRESHOLD = 1e-4   # above this the system is overconstrained (conflicting)
RANK_TOL = 1e-6         # tolerance for numerical rank computation


def solve(yaml_str: str) -> dict:
    """Solve all sketch features in a YAML document.

    Returns a nested dict per feature:
        result[feature_id]["initial"][entity_id]  -> geometry
        result[feature_id]["solved"][entity_id]   -> geometry
        result[feature_id]["status"]              -> "fully_constrained" | "underconstrained" | "overconstrained"
        result[feature_id]["solve_ms"]            -> solve time in milliseconds
    """
    doc = yaml.safe_load(yaml_str)
    features = doc.get("features", [])

    result = {}
    for feature in features:
        if feature.get("kind") != "sketch":
            continue
        t0 = time.perf_counter()
        initial, solved, status = _solve_sketch(feature)
        solve_ms = (time.perf_counter() - t0) * 1000
        result[feature["id"]] = {"initial": initial, "solved": solved, "status": status, "solve_ms": round(solve_ms, 1)}
    return result


def _geometry_from_array(x, entities: dict, entity_offsets: dict) -> dict:
    out = {}
    for eid, entity in entities.items():
        off = entity_offsets[eid]
        ep = x[off:off + ENTITY_SIZES[entity["kind"]]]
        kind = entity["kind"]
        if kind == "line_segment":
            out[eid] = {
                "start": (float(ep[0]), float(ep[1])),
                "end":   (float(ep[2]), float(ep[3])),
            }
        elif kind == "circle":
            out[eid] = {
                "center": (float(ep[0]), float(ep[1])),
                "radius": float(ep[2]),
            }
        elif kind == "arc":
            cx, cy, r = float(ep[0]), float(ep[1]), float(ep[2])
            a0, a1 = float(ep[3]), float(ep[4])
            out[eid] = {
                "center":      (cx, cy),
                "radius":      r,
                "angle_start": a0,
                "angle_end":   a1,
                "start": (cx + r * math.cos(math.radians(a0)), cy + r * math.sin(math.radians(a0))),
                "end":   (cx + r * math.cos(math.radians(a1)), cy + r * math.sin(math.radians(a1))),
            }
        elif kind == "point":
            out[eid] = {"x": float(ep[0]), "y": float(ep[1])}
    return out


def _solve_sketch(feature: dict) -> tuple:
    entities = {e["id"]: e for e in feature["entities"]}
    initial = feature.get("initial", {})
    constraints = feature.get("constraints", [])

    entity_offsets: dict = {}
    params: list = []
    for eid, entity in entities.items():
        entity_offsets[eid] = len(params)
        size = ENTITY_SIZES[entity["kind"]]
        params.extend(initial.get(eid, [0.0] * size))

    x0 = np.array(params, dtype=np.float64)

    def get_params(x, eid):
        off = entity_offsets[eid]
        size = ENTITY_SIZES[entities[eid]["kind"]]
        return x[off:off + size]

    def get_point(x, ref):
        eid = ref["entity"]
        ep = get_params(x, eid)
        kind = entities[eid]["kind"]
        point = ref.get("point", "start")
        if kind == "line_segment":
            return ep[2:4] if point == "end" else ep[0:2]
        elif kind == "circle":
            return ep[0:2]
        elif kind == "arc":
            cx, cy, r = ep[0], ep[1], ep[2]
            a_deg = ep[3] if point != "end" else ep[4]
            return np.array([cx + r * np.cos(np.radians(a_deg)),
                              cy + r * np.sin(np.radians(a_deg))])
        elif kind == "point":
            return ep[0:2]
        raise ValueError(f"Unknown kind: {kind!r}")

    def residuals(x):
        r = []
        for c in constraints:
            kind = c["kind"]
            if kind == "horizontal":
                ep = get_params(x, c["target"]["entity"])
                r.append(ep[3] - ep[1])
            elif kind == "vertical":
                ep = get_params(x, c["target"]["entity"])
                r.append(ep[2] - ep[0])
            elif kind == "length":
                ep = get_params(x, c["target"]["entity"])
                dx, dy = ep[2] - ep[0], ep[3] - ep[1]
                r.append(np.sqrt(dx**2 + dy**2) - c["value"])
            elif kind == "radius":
                ep = get_params(x, c["target"]["entity"])
                r.append(ep[2] - c["value"])
            elif kind == "coincident":
                pa = get_point(x, c["a"])
                pb = get_point(x, c["b"])
                r.append(pa[0] - pb[0])
                r.append(pa[1] - pb[1])
            elif kind == "perpendicular":
                ea = get_params(x, c["a"]["entity"])
                eb = get_params(x, c["b"]["entity"])
                da = ea[2:4] - ea[0:2]
                db = eb[2:4] - eb[0:2]
                r.append(np.dot(da, db))
            elif kind == "angle":
                ea = get_params(x, c["a"]["entity"])
                eb = get_params(x, c["b"]["entity"])
                da = ea[2:4] - ea[0:2]
                db = eb[2:4] - eb[0:2]
                cos_val = np.dot(da, db) / (np.linalg.norm(da) * np.linalg.norm(db))
                r.append(cos_val - np.cos(np.radians(c["value"])))
            elif kind == "tangent":
                line_ep = get_params(x, c["line"]["entity"])
                line_dir = line_ep[2:4] - line_ep[0:2]
                line_dir = line_dir / np.linalg.norm(line_dir)
                arc_ep = get_params(x, c["arc"]["entity"])
                arc_pt = c["arc"].get("point", "start")
                a_deg = arc_ep[3] if arc_pt != "end" else arc_ep[4]
                radius_dir = np.array([np.cos(np.radians(a_deg)), np.sin(np.radians(a_deg))])
                r.append(np.dot(line_dir, radius_dir))
            elif kind == "equal_length":
                ea = get_params(x, c["a"]["entity"])
                eb = get_params(x, c["b"]["entity"])
                len_a = np.sqrt((ea[2] - ea[0])**2 + (ea[3] - ea[1])**2)
                len_b = np.sqrt((eb[2] - eb[0])**2 + (eb[3] - eb[1])**2)
                r.append(len_a - len_b)
            elif kind == "point_distance":
                pa = get_point(x, c["a"])
                pb = get_point(x, c["b"])
                dist = np.sqrt((pb[0] - pa[0])**2 + (pb[1] - pa[1])**2)
                r.append(dist - c["value"])
            elif kind == "midpoint":
                ep = get_params(x, c["line"]["entity"])
                mid = np.array([(ep[0] + ep[2]) / 2, (ep[1] + ep[3]) / 2])
                pt = get_point(x, c["point"])
                axis = c.get("axis", "both")
                if axis in ("x", "both"):
                    r.append(pt[0] - mid[0])
                if axis in ("y", "both"):
                    r.append(pt[1] - mid[1])
            elif kind == "normal":
                line_ep = get_params(x, c["line"]["entity"])
                line_dir = line_ep[2:4] - line_ep[0:2]
                line_dir = line_dir / np.linalg.norm(line_dir)
                arc_ep = get_params(x, c["arc"]["entity"])
                arc_pt = c["arc"].get("point", "start")
                a_deg = arc_ep[3] if arc_pt != "end" else arc_ep[4]
                radius_dir = np.array([np.cos(np.radians(a_deg)), np.sin(np.radians(a_deg))])
                r.append(line_dir[0] * radius_dir[1] - line_dir[1] * radius_dir[0])
            elif kind == "concentric":
                ea = get_params(x, c["a"]["entity"])
                eb = get_params(x, c["b"]["entity"])
                r.append(ea[0] - eb[0])
                r.append(ea[1] - eb[1])
            elif kind == "fixed":
                pt = get_point(x, c["target"])
                r.append(pt[0] - c["x"])
                r.append(pt[1] - c["y"])
            else:
                raise ValueError(f"Unknown constraint kind: {kind!r}")
        return np.array(r) if r else np.zeros(0)

    opt = least_squares(residuals, x0, method="trf", jac="3-point", ftol=1e-10, xtol=1e-10, gtol=1e-10, max_nfev=10000)
    x_sol = opt.x
    final_loss = 2.0 * float(opt.cost)  # least_squares reports 0.5 * sum(residuals**2)

    # Detect constraint status via Jacobian rank (opt.jac available from trf method)
    J = opt.jac if opt.jac is not None and opt.jac.shape[0] > 0 else np.zeros((0, len(x_sol)))
    rank = int(np.linalg.matrix_rank(J, tol=RANK_TOL))
    n_params = len(x_sol)

    if final_loss > LOSS_THRESHOLD:
        status = "overconstrained"
    elif rank < n_params - 3:
        status = "underconstrained"
    else:
        status = "fully_constrained"

    return (
        _geometry_from_array(x0, entities, entity_offsets),
        _geometry_from_array(x_sol, entities, entity_offsets),
        status,
    )
