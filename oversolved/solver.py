import math
import time
from typing import Any
import yaml
import numpy as np
from scipy.optimize import least_squares
from oversolved.topology import detect_topology


ENTITY_SIZES = {
    "line_segment": 4,  # x1, y1, x2, y2
    "circle": 3,  # cx, cy, r
    "arc": 5,  # cx, cy, r, a_start_deg, a_end_deg
    "point": 2,  # x, y
}

# above this the system is overconstrained (conflicting)
LOSS_THRESHOLD = 1e-4
RANK_TOL = 1e-6         # tolerance for numerical rank computation


def solve(yaml_str: str) -> dict:
    """Solve all sketch features in a YAML document.

    Returns the spec-compliant format with top-level solve_ms and result wrapper.
    Per-feature response contains only new information produced by solving:
        result[feature_id]["status"]      -> "fully_constrained" | "underconstrained" | "overconstrained" | "exception"
        result[feature_id]["solve_ms"]    -> float, wall-clock solve time
        result[feature_id]["geometry"]    -> {entity_id: [params]}  solved flat params (same format as input initial)
        result[feature_id]["features"]    -> {entity_id: {status}}  per-entity constraint status
        result[feature_id]["topology"]    -> {vertices, intersection_points, surfaces}
    """
    doc = yaml.safe_load(yaml_str)
    features = doc.get("features", [])

    t0 = time.perf_counter()
    result = {}
    for feature in features:
        feature_result = _try_solve_feature(feature)
        result[feature["id"]] = feature_result

    total_ms = round((time.perf_counter() - t0) * 1000, 1)
    return {
        "solve_ms": total_ms,
        "result": result
    }


def _try_solve_feature(feature: Any) -> dict:
    t0 = time.perf_counter()
    try:
        result = _solve_feature(feature)
        result["solve_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        return result
    except Exception as e:
        return {
            "solve_ms": round((time.perf_counter() - t0) * 1000, 1),
            "status": "exception",
            "exception": str(e)
        }


def _solve_feature(feature: Any) -> dict:
    kind = feature.get("kind")
    if kind == "sketch":
        feature_result = _solve_sketch(feature)
        return feature_result
    raise Exception(f"unknown feature type: '{kind}'")


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def _geometry_from_array(
        x, entities: dict,
        entity_offsets: dict) -> dict[str, Any]:  # noqa: E501
    out: dict[str, Any] = {}
    for eid, entity in entities.items():
        off = entity_offsets[eid]
        ep = x[off:off + ENTITY_SIZES[entity["kind"]]]
        kind = entity["kind"]
        is_construction = entity.get("construction", False)
        if kind == "line_segment":
            out[eid] = {
                "start": [float(ep[0]), float(ep[1])],
                "end": [float(ep[2]), float(ep[3])],
            }
            if is_construction:
                out[eid]["construction"] = True
        elif kind == "circle":
            out[eid] = {
                "center": [float(ep[0]), float(ep[1])],
                "radius": float(ep[2]),
            }
            if is_construction:
                out[eid]["construction"] = True
        elif kind == "arc":
            cx, cy, r = float(ep[0]), float(ep[1]), float(ep[2])
            a0, a1 = float(ep[3]), float(ep[4])
            out[eid] = {
                "center": [
                    cx,
                    cy],
                "radius": r,
                "angle_start": a0,
                "angle_end": a1,
                "start": [
                    cx +
                    r *
                    math.cos(
                        math.radians(a0)),
                    cy +
                    r *
                    math.sin(
                        math.radians(a0))],
                "end": [
                    cx +
                    r *
                    math.cos(
                        math.radians(a1)),
                    cy +
                    r *
                    math.sin(
                        math.radians(a1))],
            }
            if is_construction:
                out[eid]["construction"] = True
        elif kind == "point":
            out[eid] = {"x": float(ep[0]), "y": float(ep[1])}
            if is_construction:
                out[eid]["construction"] = True
    return out


def _params_from_array(x, entities: dict, entity_offsets: dict) -> dict:
    """Return flat parameter arrays per entity — same format as the input `initial` block."""
    out = {}
    for eid, entity in entities.items():
        off = entity_offsets[eid]
        size = ENTITY_SIZES[entity["kind"]]
        out[eid] = [round(float(v), 10) for v in x[off:off + size]]
    return out


def _geom_point(geom: dict, ref: dict) -> list:
    """Return [x, y] for a constraint point reference {entity, point?}."""
    e = geom[ref["entity"]]
    pt = ref.get("point", "start")
    if "start" in e and "end" in e and "radius" in e:   # arc
        return e["start"] if pt != "end" else e["end"]
    elif "start" in e:                                   # line_segment
        return e["end"] if pt == "end" else e["start"]
    elif "center" in e:                                  # circle
        return list(e["center"])
    else:                                                # point
        return [e["x"], e["y"]]


# ---------------------------------------------------------------------------
# Constraint render data
# ---------------------------------------------------------------------------

def _constraint_render(c: dict, geom: dict) -> dict:
    """Compute geometric render data for a single constraint using solved geometry."""
    kind = c["kind"]

    if kind == "horizontal":
        if "a" in c:
            pa = _geom_point(geom, c["a"])
            pb = _geom_point(geom, c["b"])
            at = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]
            return {"kind": "symbol_h", "at": at, "entity": c["a"]["entity"]}
        eid = c["target"]["entity"]
        e = geom[eid]
        at = [(e["start"][0] + e["end"][0]) / 2,
              (e["start"][1] + e["end"][1]) / 2]
        return {"kind": "symbol_h", "at": at, "entity": eid}

    elif kind == "vertical":
        if "a" in c:
            pa = _geom_point(geom, c["a"])
            pb = _geom_point(geom, c["b"])
            at = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]
            return {"kind": "symbol_v", "at": at, "entity": c["a"]["entity"]}
        eid = c["target"]["entity"]
        e = geom[eid]
        at = [(e["start"][0] + e["end"][0]) / 2,
              (e["start"][1] + e["end"][1]) / 2]
        return {"kind": "symbol_v", "at": at, "entity": eid}

    elif kind == "length":
        eid = c["target"]["entity"]
        e = geom[eid]
        dx = e["end"][0] - e["start"][0]
        dy = e["end"][1] - e["start"][1]
        n = math.hypot(dx, dy)
        normal = [-dy / n, dx / n] if n > 0 else [0.0, 1.0]
        return {
            "kind": "dim_linear",
            "p1": e["start"],
            "p2": e["end"],
            "value": c["value"],
            "normal": normal,
            "entity": eid}

    elif kind == "radius":
        eid = c["target"]["entity"]
        e = geom[eid]
        center = e["center"]
        edge = e["start"] if "start" in e else [
            e["center"][0] + e["radius"], e["center"][1]]
        return {
            "kind": "dim_radius",
            "p1": center,
            "p2": edge,
            "value": c["value"],
            "entity": eid}

    elif kind == "coincident":
        eid = c["a"]["entity"]
        return {
            "kind": "symbol_coincident",
            "at": _geom_point(
                geom,
                c["a"]),
            "entity": eid}

    elif kind == "perpendicular":
        ea_id = c["a"]["entity"]
        eb_id = c["b"]["entity"]
        ea = geom[ea_id]
        eb = geom[eb_id]
        if "center" in eb:
            arc_ref = c["b"]
            pt = eb["start"] if arc_ref.get("point", "start") != "end" else eb["end"]
            return {"kind": "symbol_perp", "at": pt, "entity": eb_id}
        elif "center" in ea:
            arc_ref = c["a"]
            pt = ea["start"] if arc_ref.get("point", "start") != "end" else ea["end"]
            return {"kind": "symbol_perp", "at": pt, "entity": ea_id}
        else:
            return {"kind": "symbol_perp", "at": ea["end"], "entity": ea_id}

    elif kind == "parallel":
        eid = c["a"]["entity"]
        ea = geom[eid]
        at = [(ea["start"][0] + ea["end"][0]) / 2, (ea["start"][1] + ea["end"][1]) / 2]
        return {"kind": "symbol_parallel", "at": at, "entity": eid}

    elif kind == "angle":
        eid = c["a"]["entity"]
        ea, eb = geom[eid], geom[c["b"]["entity"]]
        return {
            "kind": "dim_angle",
            "p1": ea["start"],
            "p2": ea["end"],
            "p3": eb["end"],
            "value": c["value"],
            "entity": eid}

    elif kind == "tangent":
        eid = c["arc"]["entity"]
        arc = geom[eid]
        pt = arc["start"] if c["arc"].get(
            "point", "start") != "end" else arc["end"]
        return {"kind": "symbol_tangent", "at": pt, "entity": eid}

    elif kind == "normal":
        eid = c["arc"]["entity"]
        arc = geom[eid]
        pt = arc["start"] if c["arc"].get(
            "point", "start") != "end" else arc["end"]
        return {"kind": "symbol_normal", "at": pt, "entity": eid}

    elif kind == "equal_length":
        eid = c["a"]["entity"]
        ea, eb = geom[eid], geom[c["b"]["entity"]]
        at_a = [(ea["start"][0] + ea["end"][0]) / 2,
                (ea["start"][1] + ea["end"][1]) / 2]
        at_b = [(eb["start"][0] + eb["end"][0]) / 2,
                (eb["start"][1] + eb["end"][1]) / 2]
        return {
            "kind": "symbol_equal",
            "at_a": at_a,
            "at_b": at_b,
            "entity": eid}

    elif kind == "point_distance":
        eid = c["a"]["entity"]
        pa = _geom_point(geom, c["a"])
        pb = _geom_point(geom, c["b"])
        dx, dy = pb[0] - pa[0], pb[1] - pa[1]
        n = math.hypot(dx, dy)
        normal = [-dy / n, dx / n] if n > 0 else [0.0, 1.0]
        return {
            "kind": "dim_linear",
            "p1": pa,
            "p2": pb,
            "value": c["value"],
            "normal": normal,
            "entity": eid}

    elif kind == "midpoint":
        eid = c["line"]["entity"]
        e = geom[eid]
        at = [(e["start"][0] + e["end"][0]) / 2,
              (e["start"][1] + e["end"][1]) / 2]
        return {
            "kind": "symbol_midpoint",
            "at": at,
            "axis": c.get(
                "axis",
                "both"),
            "entity": eid}

    elif kind == "concentric":
        eid = c["a"]["entity"]
        e = geom[eid]
        center = e["center"] if "center" in e else [e["x"], e["y"]]
        return {"kind": "symbol_concentric", "at": center, "entity": eid}

    elif kind == "fixed":
        eid = c["target"]["entity"]
        at = _geom_point(geom, c["target"])
        return {
            "kind": "symbol_fixed",
            "at": at,
            "x": c.get("x", at[0]),
            "y": c.get("y", at[1]),
            "entity": eid}

    return {"kind": "unknown"}


# ---------------------------------------------------------------------------
# Per-entity constraint status
# ---------------------------------------------------------------------------

def _entity_status(
        J,
        rank,
        entities,
        entity_offsets,
        n_params,
        overall_status):
    """Return per-entity 'fully_constrained' | 'underconstrained' | 'overconstrained'.

    For each entity, temporarily pin all its parameters (augment J with identity
    rows for those columns).  If the rank increases, those parameters had free
    DOF — the entity is underconstrained.  This matches CAD UX: an element is
    blue whenever any of its DOF are unconstrained, including position freedom
    in a freely-floating (no fixed) sketch.
    """
    if overall_status == "overconstrained":
        return {eid: "overconstrained" for eid in entities}

    result = {}
    for eid, entity in entities.items():
        off = entity_offsets[eid]
        size = ENTITY_SIZES[entity["kind"]]
        pin = np.zeros((size, n_params))
        for k in range(size):
            pin[k, off + k] = 1.0
        J_aug = np.vstack([J, pin]) if J.shape[0] > 0 else pin
        new_rank = int(np.linalg.matrix_rank(J_aug, tol=RANK_TOL))
        result[eid] = "underconstrained" if new_rank > rank else "fully_constrained"
    return result


# ---------------------------------------------------------------------------
# Sketch solver
# ---------------------------------------------------------------------------

def _solve_sketch(feature: dict) -> dict:
    entities = {e["id"]: e for e in feature["entities"]}
    initial = feature.get("initial", {})
    constraints = feature.get("constraints", [])

    entity_offsets: dict = {}
    params: list = []
    for eid, entity in entities.items():
        entity_offsets[eid] = len(params)
        size = ENTITY_SIZES[entity["kind"]]
        params.extend(initial.get(eid, [0.0] * size))

    def _constraint_entity_ids(c: dict) -> list:
        """Return all entity IDs referenced by a constraint."""
        ids = []
        for key in ("target", "line", "arc", "point"):
            if key in c and isinstance(c[key], dict) and "entity" in c[key]:
                ids.append(c[key]["entity"])
        for key in ("a", "b"):
            if key in c and isinstance(c[key], dict) and "entity" in c[key]:
                ids.append(c[key]["entity"])
        return ids

    constraints = [
        c for c in constraints
        if all(eid in entities for eid in _constraint_entity_ids(c))
    ]

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

    def residuals(x, clist=None):
        r = []
        for c in (clist if clist is not None else constraints):
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
            elif kind == "coincident":
                pa = get_point(x, c["a"])
                pb = get_point(x, c["b"])
                r.append(pa[0] - pb[0])
                r.append(pa[1] - pb[1])
            elif kind == "perpendicular":
                ea_id = c["a"]["entity"]
                eb_id = c["b"]["entity"]
                ea_kind = entities[ea_id]["kind"]
                eb_kind = entities[eb_id]["kind"]
                if ea_kind == "line_segment" and eb_kind == "line_segment":
                    ea = get_params(x, ea_id)
                    eb = get_params(x, eb_id)
                    da = ea[2:4] - ea[0:2]
                    db = eb[2:4] - eb[0:2]
                    r.append(np.dot(da, db))
                else:
                    line_ref = c["a"] if ea_kind == "line_segment" else c["b"]
                    arc_ref = c["b"] if ea_kind == "line_segment" else c["a"]
                    line_ep = get_params(x, line_ref["entity"])
                    line_dir = line_ep[2:4] - line_ep[0:2]
                    line_dir = line_dir / np.linalg.norm(line_dir)
                    arc_ep = get_params(x, arc_ref["entity"])
                    arc_pt = arc_ref.get("point", "start")
                    a_deg = arc_ep[3] if arc_pt != "end" else arc_ep[4]
                    radius_dir = np.array(
                        [np.cos(np.radians(a_deg)), np.sin(np.radians(a_deg))])
                    r.append(
                        line_dir[0] * radius_dir[1] - line_dir[1] * radius_dir[0])
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
                cos_val = np.dot(da, db) / (np.linalg.norm(da)
                                            * np.linalg.norm(db))
                r.append(cos_val - np.cos(np.radians(c["value"])))
            elif kind == "tangent":
                line_ep = get_params(x, c["line"]["entity"])
                line_dir = line_ep[2:4] - line_ep[0:2]
                line_dir = line_dir / np.linalg.norm(line_dir)
                arc_ep = get_params(x, c["arc"]["entity"])
                arc_pt = c["arc"].get("point", "start")
                a_deg = arc_ep[3] if arc_pt != "end" else arc_ep[4]
                radius_dir = np.array(
                    [np.cos(np.radians(a_deg)), np.sin(np.radians(a_deg))])
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
                radius_dir = np.array(
                    [np.cos(np.radians(a_deg)), np.sin(np.radians(a_deg))])
                r.append(
                    line_dir[0] *
                    radius_dir[1] -
                    line_dir[1] *
                    radius_dir[0])
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

    opt = least_squares(residuals, x0, method="trf", jac="3-point",
                        ftol=1e-10, xtol=1e-10, gtol=1e-10, max_nfev=10000)
    x_sol = opt.x
    # least_squares cost = 0.5 * sum(residuals**2)
    final_loss = 2.0 * float(opt.cost)

    # Constraint status via Jacobian rank
    J = opt.jac if opt.jac is not None and opt.jac.shape[0] > 0 else np.zeros(
        (0, len(x_sol)))
    rank = int(np.linalg.matrix_rank(J, tol=RANK_TOL))
    n_params = len(x_sol)

    # Each fixed constraint pins 2 rigid-body DOF (tx, ty). Reduce the 3-DOF
    # rigid-body allowance accordingly so genuinely free parameters are
    # flagged.
    n_fixed_pinned = sum(
        ENTITY_SIZES[entities[c["target"]["entity"]]["kind"]]
        if ("point" not in c.get("target", {}) and "x" not in c and "y" not in c)
        else 2
        for c in constraints if c["kind"] == "fixed"
    )
    rigid_body_dof = max(0, 3 - n_fixed_pinned)

    if final_loss > LOSS_THRESHOLD:
        status = "overconstrained"
    elif rank < n_params - rigid_body_dof:
        status = "underconstrained"
    else:
        status = "fully_constrained"

    geom_solved = _geometry_from_array(x_sol, entities, entity_offsets)

    # Topology: detect intersection points and bounded surfaces
    topology = detect_topology(geom_solved)
    for vid, pt in topology['intersection_points'].items():
        geom_solved[vid] = {'x': pt['x'], 'y': pt['y'], 'intersection': True}

    # Per-entity status via null-space analysis.
    # The null space of J encodes all unconstrained directions. We project out
    # the 3 rigid-body modes (translation x/y, rotation) so that a freely
    # floating but shape-determined sketch doesn't flag its entities as free.
    entity_status = _entity_status(
        J, rank, entities, entity_offsets, n_params, status)

    # Per-constraint residual (sum of squares) and render data
    constraints_out = {}
    for c in constraints:
        r_vec = residuals(x_sol, [c])
        constraints_out[c["id"]] = {
            "residual": round(float(np.sum(r_vec**2)), 12),
            "render": _constraint_render(c, geom_solved),
        }

    # Convert geometry from named-field format to flat array format (same as input initial)
    geometry_flat = _params_from_array(x_sol, entities, entity_offsets)

    # Convert entity_status to features format: {entity_id: {status: "..."}}
    features = {eid: {"status": st} for eid, st in entity_status.items()}

    return {
        "status": status,
        "geometry": geometry_flat,
        "features": features,
        "topology": topology,
    }
