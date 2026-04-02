import math
import time
from typing import Any, Optional
import yaml
import numpy as np
from scipy.optimize import least_squares
from oversolved.topology import detect_topology
from oversolved.query import Repository, _parse_ancestry


_FRONT_PLANE: dict = {
    "type": "plane",
    "origin": [0, 0, 0],
    "x_axis": [1, 0, 0],
    "y_axis": [0, 1, 0],
    "normal": [0, 0, 1],
}


ENTITY_SIZES = {
    "line": 4,  # x1, y1, x2, y2
    "circle": 3,  # cx, cy, r
    "arc": 5,  # cx, cy, r, a_start_deg, a_end_deg
    "point": 2,  # x, y
    "projected_line": 4,
    "projected_circle": 3,
    "projected_arc": 5,
    "projected_point": 2,
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

    # Global repo accumulates solved geometry so later sketches can reference
    # entities from earlier sketches via @absolute query strings.
    global_repo = Repository()
    global_repo.register("builtin_origin",      {"external_xy": [0.0, 0.0]})
    global_repo.register("builtin_plane_front", {"type": "plane", "origin": [0, 0, 0], "x_axis": [1, 0, 0], "y_axis": [0, 1, 0],  "normal": [0, 0, 1]})
    global_repo.register("builtin_plane_top",   {"type": "plane", "origin": [0, 0, 0], "x_axis": [1, 0, 0], "y_axis": [0, 0, -1], "normal": [0, 1, 0]})
    global_repo.register("builtin_plane_right", {"type": "plane", "origin": [0, 0, 0], "x_axis": [0, 0, -1], "y_axis": [0, 1, 0], "normal": [1, 0, 0]})

    t0 = time.perf_counter()
    result = {}
    for feature in features:
        feature_result = _try_solve_feature(feature, global_repo)
        result[feature["id"]] = feature_result
        # After solving, register this sketch's geometry into global_repo so
        # subsequent sketches can reference it via @absolute query strings.
        if "geometry" in feature_result:
            _register_solved_geometry(global_repo, feature["id"], feature, feature_result["geometry"])
        # Store plane_transform so downstream plane features can convert 2D sketch
        # coordinates to 3D world coordinates (used by three_point, through_point, etc.)
        if "plane_transform" in feature_result:
            pt = feature_result["plane_transform"]
            rot = pt["rotation"]
            global_repo.register("_pt_" + feature["id"], {
                "origin": pt["origin"],
                "x_axis": rot[0:3],
                "y_axis": rot[3:6],
                "normal": rot[6:9],
            })
        # Register topology surfaces as face-typed planes so later sketches can
        # use a topology face as a sketch plane via its ancestry query string.
        if "plane_transform" in feature_result and "topology" in feature_result:
            pt = feature_result["plane_transform"]
            rot = pt["rotation"]
            _register_topology_surfaces(global_repo, feature_result["topology"], {
                "type": "face",
                "origin": pt["origin"],
                "x_axis": rot[0:3],
                "y_axis": rot[3:6],
                "normal": rot[6:9],
            })

    total_ms = round((time.perf_counter() - t0) * 1000, 1)
    return {
        "solve_ms": total_ms,
        "result": result
    }


def solve_features(spec: dict) -> dict:
    """Solve a spec dict and return results as a list indexed by feature position.

    Returns {'features': [result_per_feature, ...]}.
    Results for plane features include 'plane' key; sketches include 'geometry'.
    """
    features = spec.get("features", [])

    global_repo = Repository()
    global_repo.register("builtin_origin",      {"external_xy": [0.0, 0.0]})
    global_repo.register("builtin_plane_front", {"type": "plane", "origin": [0, 0, 0], "x_axis": [1, 0, 0], "y_axis": [0, 1, 0],  "normal": [0, 0, 1]})
    global_repo.register("builtin_plane_top",   {"type": "plane", "origin": [0, 0, 0], "x_axis": [1, 0, 0], "y_axis": [0, 0, -1], "normal": [0, 1, 0]})
    global_repo.register("builtin_plane_right", {"type": "plane", "origin": [0, 0, 0], "x_axis": [0, 0, -1], "y_axis": [0, 1, 0], "normal": [1, 0, 0]})

    results = []
    for feature in features:
        feature_result = _try_solve_feature(feature, global_repo)
        fid = feature.get("id", "")

        # Convert flat-params geometry to rich dict format for solve_features callers.
        if "geometry" in feature_result and feature.get("kind") == "sketch":
            feature_result = dict(feature_result)
            feature_result["geometry"] = _enrich_geometry(
                feature_result["geometry"], feature
            )

        results.append(feature_result)

        if "geometry" in feature_result:
            _register_solved_geometry_slash(global_repo, fid, feature, feature_result["geometry"])
        # Store plane_transform and topology so extrude can access them.
        if "plane_transform" in feature_result:
            pt = feature_result["plane_transform"]
            rot = pt["rotation"]
            global_repo.register("_pt_" + fid, {
                "origin": pt["origin"],
                "x_axis": rot[0:3],
                "y_axis": rot[3:6],
                "normal": rot[6:9],
            })
        if "topology" in feature_result:
            global_repo.register("_topo_" + fid, feature_result["topology"])

    return {"features": results}


def _enrich_geometry(flat_geometry: dict, feature: dict) -> dict:
    """Convert flat-param geometry to rich dict format, adding projected:True for projected kinds."""
    entities = {e["id"]: e for e in feature.get("entities", [])}
    rich: dict = {}
    for eid, params in flat_geometry.items():
        entity = entities.get(eid)
        kind = entity["kind"] if entity else ""
        if kind == "line":
            rich[eid] = {"start": list(params[0:2]), "end": list(params[2:4])}
        elif kind == "circle":
            rich[eid] = {"center": list(params[0:2]), "radius": float(params[2])}
        elif kind == "arc":
            cx, cy, r, a0, a1 = params
            rich[eid] = {"center": [float(cx), float(cy)], "radius": float(r),
                         "angle_start": float(a0), "angle_end": float(a1)}
        elif kind == "point":
            rich[eid] = {"xy": list(params[0:2])}
        elif kind == "projected_line":
            rich[eid] = {"start": list(params[0:2]), "end": list(params[2:4]), "projected": True}
        elif kind == "projected_circle":
            rich[eid] = {"center": list(params[0:2]), "radius": float(params[2]), "projected": True}
        elif kind == "projected_arc":
            cx, cy, r, a0, a1 = params
            rich[eid] = {"center": [float(cx), float(cy)], "radius": float(r),
                         "angle_start": float(a0), "angle_end": float(a1), "projected": True}
        elif kind == "projected_point":
            rich[eid] = {"xy": list(params[0:2]), "projected": True}
        else:
            rich[eid] = list(params)
    return rich


def _register_solved_geometry_slash(global_repo: Repository, feature_id: str, feature: dict, geometry: dict) -> None:
    """Register solved geometry using slash-separated query paths (@feature/entity/sub).
    Accepts both flat-params and rich-dict geometry formats."""
    entities = {e["id"]: e for e in feature.get("entities", [])}
    for eid, val in geometry.items():
        entity = entities.get(eid)
        if entity is None:
            continue
        kind = entity["kind"]
        prefix = feature_id + "/" + eid
        # Normalize to flat params for registration
        if isinstance(val, dict):
            if kind in ("line", "projected_line"):
                params = list(val.get("start", [0, 0])) + list(val.get("end", [0, 0]))
            elif kind in ("circle", "projected_circle"):
                params = list(val.get("center", [0, 0])) + [val.get("radius", 0)]
            elif kind in ("arc", "projected_arc"):
                cx, cy = val.get("center", [0, 0])
                params = [cx, cy, val.get("radius", 0), val.get("angle_start", 0), val.get("angle_end", 0)]
            elif kind in ("point", "projected_point"):
                params = list(val.get("xy", [0, 0]))
            else:
                continue
        else:
            params = list(val)
        global_repo.register(prefix, {"external_params": params, "kind": kind, "sketch_id": feature_id})
        if kind in ("line", "projected_line"):
            global_repo.register(prefix + "/start", {"external_xy": list(params[0:2]), "sketch_id": feature_id})
            global_repo.register(prefix + "/end",   {"external_xy": list(params[2:4]), "sketch_id": feature_id})
        elif kind in ("circle", "projected_circle"):
            global_repo.register(prefix + "/center", {"external_xy": list(params[0:2]), "sketch_id": feature_id})
        elif kind in ("arc", "projected_arc"):
            cx, cy, r = params[0], params[1], params[2]
            a_start, a_end = params[3], params[4]
            global_repo.register(prefix + "/start",  {"external_xy": [cx + r * math.cos(math.radians(a_start)), cy + r * math.sin(math.radians(a_start))], "sketch_id": feature_id})
            global_repo.register(prefix + "/end",    {"external_xy": [cx + r * math.cos(math.radians(a_end)),   cy + r * math.sin(math.radians(a_end))], "sketch_id": feature_id})
            global_repo.register(prefix + "/center", {"external_xy": [cx, cy], "sketch_id": feature_id})
        elif kind in ("point", "projected_point"):
            global_repo.register(prefix + "/xy", {"external_xy": list(params[0:2]), "sketch_id": feature_id})


def _register_solved_geometry(global_repo: Repository, feature_id: str, feature: dict, geometry: dict) -> None:
    """Register solved geometry from a sketch into the global repo as fixed external references."""
    entities = {e["id"]: e for e in feature.get("entities", [])}
    for eid, params in geometry.items():
        entity = entities.get(eid)
        if entity is None:
            continue
        kind = entity["kind"]
        global_repo.register(feature_id + eid, {"external_params": params, "kind": kind, "sketch_id": feature_id})
        if kind == "line":
            global_repo.register(feature_id + eid + "start", {"external_xy": list(params[0:2]), "sketch_id": feature_id})
            global_repo.register(feature_id + eid + "end",   {"external_xy": list(params[2:4]), "sketch_id": feature_id})
        elif kind == "circle":
            global_repo.register(feature_id + eid + "center", {"external_xy": list(params[0:2]), "sketch_id": feature_id})
        elif kind == "arc":
            cx, cy, r = params[0], params[1], params[2]
            a_start, a_end = params[3], params[4]
            global_repo.register(feature_id + eid + "start",  {"external_xy": [cx + r * math.cos(math.radians(a_start)), cy + r * math.sin(math.radians(a_start))], "sketch_id": feature_id})
            global_repo.register(feature_id + eid + "end",    {"external_xy": [cx + r * math.cos(math.radians(a_end)),   cy + r * math.sin(math.radians(a_end))], "sketch_id": feature_id})
            global_repo.register(feature_id + eid + "center", {"external_xy": [cx, cy], "sketch_id": feature_id})
        elif kind == "point":
            global_repo.register(feature_id + eid + "xy", {"external_xy": list(params[0:2]), "sketch_id": feature_id})


def _plane_transform(plane_obj: dict) -> dict:
    """Convert a plane object (x_axis, y_axis, normal, origin) to a plane_transform dict."""
    x_axis = plane_obj.get("x_axis", [1, 0, 0])
    y_axis = plane_obj.get("y_axis", [0, 1, 0])
    normal = plane_obj.get("normal", [0, 0, 1])
    origin = plane_obj.get("origin", [0, 0, 0])
    return {"rotation": list(x_axis) + list(y_axis) + list(normal), "origin": list(origin)}


def _register_topology_surfaces(global_repo: Repository, topology: dict, plane_obj: dict) -> None:
    """Register each topology surface as a face-typed plane in the global repository."""
    x_axis = plane_obj["x_axis"]
    y_axis = plane_obj["y_axis"]
    normal = plane_obj["normal"]
    origin = plane_obj["origin"]

    for surface in topology.get("surfaces", []):
        query = surface.get("query")
        if not query or not query.startswith('?'):
            continue

        # Compute world-space centroid from the surface boundary's 2D sketch coords.
        pts_2d = []
        for edge in surface["boundary"]:
            if "start" in edge:
                pts_2d.append(edge["start"])
            if "end" in edge:
                pts_2d.append(edge["end"])

        if pts_2d:
            u = sum(p[0] for p in pts_2d) / len(pts_2d)
            v = sum(p[1] for p in pts_2d) / len(pts_2d)
            world_origin = [
                origin[0] + u * x_axis[0] + v * y_axis[0],
                origin[1] + u * x_axis[1] + v * y_axis[1],
                origin[2] + u * x_axis[2] + v * y_axis[2],
            ]
        else:
            world_origin = list(origin)

        ids, _ = _parse_ancestry(query)
        global_repo.register_anchestor(ids, {
            "type": "face",
            "origin": world_origin,
            "x_axis": list(x_axis),
            "y_axis": list(y_axis),
            "normal": list(normal),
        })


def _try_solve_feature(feature: Any, global_repo: Repository) -> dict:
    t0 = time.perf_counter()
    try:
        result = _solve_feature(feature, global_repo)
        result["solve_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        return result
    except Exception as e:
        return {
            "solve_ms": round((time.perf_counter() - t0) * 1000, 1),
            "status": "exception",
            "exception": str(e)
        }


def _solve_feature(feature: Any, global_repo: Repository) -> dict:
    kind = feature.get("kind")
    if kind == "sketch":
        feature_result = _solve_sketch(feature, global_repo)
        return feature_result
    if kind == "plane":
        return _solve_plane(feature, global_repo)
    if kind == "extrude":
        return _solve_extrude(feature, global_repo)
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
        if kind == "line":
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
        elif kind == "projected_line":
            out[eid] = {
                "start": [float(ep[0]), float(ep[1])],
                "end": [float(ep[2]), float(ep[3])],
            }
        elif kind == "projected_circle":
            out[eid] = {
                "center": [float(ep[0]), float(ep[1])],
                "radius": float(ep[2]),
            }
        elif kind == "projected_arc":
            cx, cy, r = float(ep[0]), float(ep[1]), float(ep[2])
            a0, a1 = float(ep[3]), float(ep[4])
            out[eid] = {
                "center": [cx, cy],
                "radius": r,
                "angle_start": a0,
                "angle_end": a1,
                "start": [cx + r * math.cos(math.radians(a0)), cy + r * math.sin(math.radians(a0))],
                "end": [cx + r * math.cos(math.radians(a1)), cy + r * math.sin(math.radians(a1))],
            }
        elif kind == "projected_point":
            out[eid] = {"x": float(ep[0]), "y": float(ep[1])}
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
    elif "start" in e:                                   # line
        return e["end"] if pt == "end" else e["start"]
    elif "center" in e:                                  # circle
        return list(e["center"])
    else:                                                # point
        return [e["x"], e["y"]]


# ---------------------------------------------------------------------------
# Constraint render data
# ---------------------------------------------------------------------------

def _pick_arc_ref(c: dict, geom: dict) -> dict | None:
    """When a constraint uses a/b keys instead of line/arc, return the ref whose
    entity is an arc or circle (has a 'center' key in geom)."""
    for key in ("b", "a"):
        ref = c.get(key)
        if ref and "center" in geom.get(ref.get("entity", ""), {}):
            return ref
    return None


def _pick_line_ref(c: dict, geom: dict) -> dict | None:
    """When a constraint uses a/b keys, return the ref whose entity is a line."""
    for key in ("a", "b"):
        ref = c.get(key)
        if ref and "start" in geom.get(ref.get("entity", ""), {}):
            return ref
    return None


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

    elif kind == "diameter":
        eid = c["target"]["entity"]
        e = geom[eid]
        cx, cy, r = e["center"][0], e["center"][1], e["radius"]
        return {
            "kind": "dim_diameter",
            "p1": [cx - r, cy],
            "p2": [cx + r, cy],
            "value": c["value"],
            "entity": eid}

    elif kind == "line_distance":
        eid_a = c["a"]["entity"]
        ea = geom[eid_a]
        dx = ea["end"][0] - ea["start"][0]
        dy = ea["end"][1] - ea["start"][1]
        n = math.hypot(dx, dy)
        nx, ny = (-dy / n, dx / n) if n > 0 else (0.0, 1.0)
        pb = _geom_point(geom, c["b"])
        # foot of perpendicular from pb onto line_a
        t = (pb[0] - ea["start"][0]) * nx + (pb[1] - ea["start"][1]) * ny
        foot = [pb[0] - t * nx, pb[1] - t * ny]
        return {
            "kind": "dim_linear",
            "p1": foot,
            "p2": list(pb),
            "value": c["value"],
            "normal": [nx, ny],
            "entity": eid_a}

    elif kind == "coincident":
        a_eid = c["a"]["entity"]
        ea = geom[a_eid]
        if "point" not in c["a"] and "start" in ea and "start" in geom.get(c["b"]["entity"], {}):
            # line-to-line collinear: place symbol at midpoint of a
            at = [(ea["start"][0] + ea["end"][0]) / 2,
                  (ea["start"][1] + ea["end"][1]) / 2]
        else:
            at = _geom_point(geom, c["a"])
        return {"kind": "symbol_coincident", "at": at, "entity": a_eid}

    elif kind == "normal":
        ea_id = c["a"]["entity"]
        eb_id = c["b"]["entity"]
        ea = geom[ea_id]
        eb = geom[eb_id]
        if "center" in eb:
            pt = eb["start"] if "start" in eb and c["b"].get("point", "start") != "end" else list(eb["center"])
            return {"kind": "symbol_normal", "at": pt, "entity": eb_id}
        elif "center" in ea:
            pt = ea["start"] if "start" in ea and c["a"].get("point", "start") != "end" else list(ea["center"])
            return {"kind": "symbol_normal", "at": pt, "entity": ea_id}
        else:
            return {"kind": "symbol_normal", "at": ea["end"], "entity": ea_id}

    elif kind == "parallel":
        eid = c["a"]["entity"]
        ea = geom[eid]
        at = [(ea["start"][0] + ea["end"][0]) / 2, (ea["start"][1] + ea["end"][1]) / 2]
        return {"kind": "symbol_parallel", "at": at, "entity": eid}

    elif kind == "angle":
        eid = c["a"]["entity"]
        ea, eb = geom[eid], geom[c["b"]["entity"]]
        # p1,p2 encode line A (direction da = p2 - p1).
        # p3,p4 encode line B (direction db = p4 - p3).
        # Both full lines are stored so the renderer can compute da and db
        # independently of which vertex configuration the two lines share.
        return {
            "kind": "dim_angle",
            "p1": ea["start"],
            "p2": ea["end"],
            "p3": eb["start"],
            "p4": eb["end"],
            "value": c["value"],
            "entity": eid}

    elif kind == "tangent":
        arc_ref = c.get("arc") or (_pick_arc_ref(c, geom))
        if not arc_ref:
            return {"kind": "unknown"}
        eid = arc_ref["entity"]
        arc = geom[eid]
        if "start" in arc:
            pt = arc["start"] if arc_ref.get("point", "start") != "end" else arc["end"]
        elif "center" in arc:
            # For a circle, find the tangent point: foot of perpendicular from
            # center to the line, clamped to the actual line segment.
            line_ref = c.get("line") or _pick_line_ref(c, geom)
            if line_ref:
                line = geom[line_ref["entity"]]
                cx, cy = arc["center"]
                x0, y0 = line["start"]
                x1, y1 = line["end"]
                dx, dy = x1 - x0, y1 - y0
                seg_len2 = dx * dx + dy * dy
                if seg_len2 > 1e-12:
                    t = ((cx - x0) * dx + (cy - y0) * dy) / seg_len2
                    t = max(0.0, min(1.0, t))
                    pt = [x0 + t * dx, y0 + t * dy]
                else:
                    pt = [x0, y0]
            else:
                pt = list(arc["center"])
        else:
            pt = list(arc["center"])
        return {"kind": "symbol_tangent", "at": pt, "entity": eid}

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
        if "line" in c:
            eid = c["line"]["entity"]
            e = geom[eid]
            at = [(e["start"][0] + e["end"][0]) / 2,
                  (e["start"][1] + e["end"][1]) / 2]
        else:
            eid = c["point_a"]["entity"]
            pa = _geom_point(geom, c["point_a"])
            pb = _geom_point(geom, c["point_b"])
            at = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]
        return {
            "kind": "symbol_midpoint",
            "at": at,
            "axis": c.get("axis", "both"),
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

ORIGIN_ID = "_origin"
ORIGIN_FIX_ID = "__builtin_origin_fix__"


# ---------------------------------------------------------------------------
# Projection helpers (3D world <-> 2D plane)
# ---------------------------------------------------------------------------

_BUILTIN_PLANES: dict = {
    "builtin_plane_front": _FRONT_PLANE,
    "builtin_plane_top":   {"type": "plane", "origin": [0, 0, 0], "x_axis": [1, 0, 0], "y_axis": [0, 0, -1], "normal": [0, 1, 0]},
    "builtin_plane_right": {"type": "plane", "origin": [0, 0, 0], "x_axis": [0, 0, -1], "y_axis": [0, 1, 0], "normal": [1, 0, 0]},
}

_PROJECTED_KINDS = frozenset({"projected_line", "projected_circle", "projected_arc", "projected_point"})


def _resolve_plane_early(plane_query: Optional[str], global_repo: Optional[Repository]) -> dict:
    """Quick plane resolution without full repo setup (used before entity_offsets are built)."""
    if not plane_query:
        return _FRONT_PLANE
    if plane_query.startswith("@"):
        builtin = _BUILTIN_PLANES.get(plane_query[1:])
        if builtin is not None:
            return builtin
        # Also look up user-defined planes in global_repo (e.g. @plane1)
        if global_repo is not None:
            p = global_repo.elements.get(plane_query[1:])
            if p and p.get("type") in ("plane", "face"):
                return p
        return _FRONT_PLANE
    if plane_query.startswith("$") and global_repo is not None:
        p = global_repo.elements.get(plane_query[1:])
        if p and p.get("type") in ("plane", "face"):
            return p
    return _FRONT_PLANE


def _2d_to_3d(xy: list, plane: dict) -> list:
    """Convert 2D local coords to 3D world coords via plane transform."""
    origin = np.array(plane["origin"])
    x_axis = np.array(plane["x_axis"])
    y_axis = np.array(plane["y_axis"])
    return (origin + xy[0] * x_axis + xy[1] * y_axis).tolist()


def _3d_to_2d(xyz: list, plane: dict) -> list:
    """Project 3D world coords onto plane, returning [u, v]."""
    origin = np.array(plane["origin"])
    x_axis = np.array(plane["x_axis"])
    y_axis = np.array(plane["y_axis"])
    v = np.array(xyz) - origin
    return [float(np.dot(v, x_axis)), float(np.dot(v, y_axis))]


def _source_sketch_id(source_query: str) -> str:
    """Extract sketch ID from '@sketch_id/...' or '@sketch_identity...' query."""
    return source_query.lstrip("@").split("/")[0]


def _resolve_source_geometry(source_query: str, global_repo: Repository) -> tuple:
    """Resolve source entity to 3D geometry. Returns (kind_hint, data_3d).

    data_3d is:
    - for point: [x, y, z]
    - for line: {'start': [x,y,z], 'end': [x,y,z]}
    - for circle: {'center': [x,y,z], 'radius': r}
    - for arc: {'center': [x,y,z], 'radius': r, 'start_angle': a, 'end_angle': b}
    """
    sketch_id = _source_sketch_id(source_query)
    source_plane = global_repo.elements.get("_pt_" + sketch_id) or _FRONT_PLANE

    data = global_repo.query(source_query)
    if data is None:
        raise ValueError(f"source not found: {source_query!r}")

    if "external_xy" in data:
        xy = data["external_xy"]
        return "point", _2d_to_3d(xy, source_plane)

    if "external_params" in data:
        params = data["external_params"]
        kind = data.get("kind", "")
        if kind == "line":
            return "line", {
                "start": _2d_to_3d(params[0:2], source_plane),
                "end":   _2d_to_3d(params[2:4], source_plane),
            }
        if kind == "circle":
            return "circle", {
                "center": _2d_to_3d(params[0:2], source_plane),
                "radius": params[2],
            }
        if kind == "arc":
            return "arc", {
                "center":      _2d_to_3d(params[0:2], source_plane),
                "radius":      params[2],
                "start_angle": params[3],
                "end_angle":   params[4],
            }

    raise ValueError(f"cannot resolve source geometry for {source_query!r}")


def _project_source_to_params(
        projected_kind: str, source_query: str,
        target_plane: dict, global_repo: Repository) -> list:
    """Compute flat 2D params for a projected entity on target_plane."""
    kind_hint, data_3d = _resolve_source_geometry(source_query, global_repo)

    if projected_kind == "projected_point":
        u, v = _3d_to_2d(data_3d, target_plane)
        return [u, v]
    if projected_kind == "projected_line":
        s2d = _3d_to_2d(data_3d["start"], target_plane)
        e2d = _3d_to_2d(data_3d["end"], target_plane)
        return s2d + e2d
    if projected_kind == "projected_circle":
        c2d = _3d_to_2d(data_3d["center"], target_plane)
        return c2d + [data_3d["radius"]]
    if projected_kind == "projected_arc":
        c2d = _3d_to_2d(data_3d["center"], target_plane)
        return c2d + [data_3d["radius"], data_3d["start_angle"], data_3d["end_angle"]]

    raise ValueError(f"unknown projected kind: {projected_kind!r}")


# ---------------------------------------------------------------------------
# Plane solver
# ---------------------------------------------------------------------------

def _get_point_3d(ref: dict, global_repo: Repository) -> np.ndarray:
    """Convert a registered point reference to a 3D world coordinate.

    Uses sketch_id + _pt_ plane transform to lift 2D local coordinates to 3D
    world space.  Falls back to [x, y, 0] when no plane transform is known.
    """
    if 'external_xy' in ref:
        xy = ref['external_xy']
        sketch_id = ref.get('sketch_id')
        if sketch_id:
            pt = global_repo.elements.get('_pt_' + sketch_id)
            if pt:
                origin = np.array(pt['origin'])
                x_axis = np.array(pt['x_axis'])
                y_axis = np.array(pt['y_axis'])
                return origin + xy[0] * x_axis + xy[1] * y_axis
        return np.array([xy[0], xy[1], 0.0])
    raise ValueError("point reference has no coordinates")


def _get_edge_3d(ref: dict, global_repo: Repository) -> tuple:
    """Return (start_3d, end_3d) for a registered edge/line reference.

    Uses sketch_id + _pt_ plane transform when available.
    Falls back to z=0 for 2D-only references.
    """
    if 'external_params' in ref and ref.get('kind') in ('line', 'projected_line'):
        p = ref['external_params']
        sketch_id = ref.get('sketch_id')
        if sketch_id:
            pt = global_repo.elements.get('_pt_' + sketch_id)
            if pt:
                origin = np.array(pt['origin'])
                x_axis = np.array(pt['x_axis'])
                y_axis = np.array(pt['y_axis'])
                start = origin + p[0] * x_axis + p[1] * y_axis
                end = origin + p[2] * x_axis + p[3] * y_axis
                return start, end
        return np.array([p[0], p[1], 0.0]), np.array([p[2], p[3], 0.0])
    if 'start' in ref and 'end' in ref:
        return np.array(ref['start']), np.array(ref['end'])
    raise ValueError("edge reference has no line coordinates")


def _normalize(v: np.ndarray) -> np.ndarray:
    """Return unit vector in direction of v."""
    n = np.linalg.norm(v)
    if n < 1e-12:
        raise ValueError("Cannot normalize zero-length vector")
    return v / n


def _rotate_frame_around_normal(
        x_axis: np.ndarray, y_axis: np.ndarray,
        normal: np.ndarray, degrees: float) -> tuple:
    """Rotate x_axis and y_axis around normal by degrees (CW looking down normal)."""
    radians = np.radians(degrees)
    cos_a = np.cos(radians)
    sin_a = np.sin(radians)
    x_new = cos_a * x_axis + sin_a * y_axis
    y_new = -sin_a * x_axis + cos_a * y_axis
    return x_new, y_new


def _plane_three_point(definition: dict, global_repo: Repository) -> tuple:
    """Three-point plane: origin at p1, x_axis toward p2, y_axis toward p3 (Gram-Schmidt)."""
    r1 = global_repo.query(definition['p1'])
    r2 = global_repo.query(definition['p2'])
    r3 = global_repo.query(definition['p3'])
    if r1 is None:
        raise ValueError(f"point not found: {definition['p1']!r}")
    if r2 is None:
        raise ValueError(f"point not found: {definition['p2']!r}")
    if r3 is None:
        raise ValueError(f"point not found: {definition['p3']!r}")
    p1 = _get_point_3d(r1, global_repo)
    p2 = _get_point_3d(r2, global_repo)
    p3 = _get_point_3d(r3, global_repo)

    origin = p1.copy()
    x_axis = _normalize(p2 - origin)
    v = p3 - origin
    y_axis_raw = v - np.dot(v, x_axis) * x_axis
    if np.linalg.norm(y_axis_raw) < 1e-10:
        raise ValueError("collinear points: cannot define a plane")
    y_axis = _normalize(y_axis_raw)
    normal = np.cross(x_axis, y_axis)
    return origin, x_axis, y_axis, normal


def _plane_on_face(definition: dict, global_repo: Repository) -> tuple:
    """Plane aligned with a topology face."""
    face_str = definition['face']
    face = global_repo.query(face_str)
    if face is None:
        raise ValueError(f"face not found: {face_str!r}")

    origin = np.array(face['centroid'])
    normal = np.array(face['normal'])

    if abs(normal[2]) < 0.9:
        arbitrary = np.array([0.0, 0.0, 1.0])
    else:
        arbitrary = np.array([1.0, 0.0, 0.0])

    x_axis = _normalize(np.cross(normal, arbitrary))
    y_axis = np.cross(normal, x_axis)
    return origin, x_axis, y_axis, normal


def _plane_on_face_edge_angle(definition: dict, global_repo: Repository) -> tuple:
    """Plane on face with X axis along an edge, rotated by angle."""
    face_str = definition['face']
    edge_str = definition['edge']
    angle = definition.get('angle', 0.0)

    face = global_repo.query(face_str)
    if face is None:
        raise ValueError(f"face not found: {face_str!r}")
    edge = global_repo.query(edge_str)
    if edge is None:
        raise ValueError(f"edge not found: {edge_str!r}")

    origin = np.array(face['centroid'])
    normal = np.array(face['normal'])

    edge_dir = _normalize(np.array(edge['end']) - np.array(edge['start']))
    x_axis_base = edge_dir - np.dot(edge_dir, normal) * normal
    x_axis_base = _normalize(x_axis_base)

    x_axis, _ = _rotate_frame_around_normal(x_axis_base, np.cross(normal, x_axis_base), normal, angle)
    y_axis = np.cross(normal, x_axis)
    return origin, x_axis, y_axis, normal


def _plane_edge_point(definition: dict, global_repo: Repository) -> tuple:
    """Plane with X axis along an edge and origin at a point."""
    edge_str = definition['edge']
    point_str = definition['point']

    edge = global_repo.query(edge_str)
    if edge is None:
        raise ValueError(f"edge not found: {edge_str!r}")
    point_ref = global_repo.query(point_str)
    if point_ref is None:
        raise ValueError(f"point not found: {point_str!r}")

    origin = _get_point_3d(point_ref, global_repo)
    edge_start, edge_end = _get_edge_3d(edge, global_repo)
    x_axis = _normalize(edge_end - edge_start)

    if abs(x_axis[2]) < 0.9:
        arbitrary = np.array([0.0, 0.0, 1.0])
    else:
        arbitrary = np.array([1.0, 0.0, 0.0])

    y_axis = _normalize(np.cross(x_axis, arbitrary))
    normal = np.cross(x_axis, y_axis)
    return origin, x_axis, y_axis, normal


def _plane_through_point(definition: dict, global_repo: Repository) -> tuple:
    """Plane parallel to a reference plane, with its origin positioned at a given point.

    The plane keeps the same orientation (x_axis, y_axis, normal) as the reference
    plane but its origin is set to the specified point projected onto the reference
    plane's normal axis.
    """
    plane_query = definition.get('plane', '')
    point_query = definition.get('point', '')
    ref_plane = global_repo.query(plane_query)
    if ref_plane is None:
        raise ValueError(f"plane not found: {plane_query!r}")
    point_ref = global_repo.query(point_query)
    if point_ref is None:
        raise ValueError(f"point not found: {point_query!r}")

    normal = np.array(ref_plane.get('normal', [0, 0, 1]))
    x_axis = np.array(ref_plane.get('x_axis', [1, 0, 0]))
    y_axis = np.array(ref_plane.get('y_axis', [0, 1, 0]))
    ref_origin = np.array(ref_plane.get('origin', [0, 0, 0]))

    point_3d = _get_point_3d(point_ref, global_repo)

    # Project point onto the normal axis to determine offset from reference origin
    t = float(np.dot(point_3d - ref_origin, normal))
    origin = ref_origin + normal * t

    return origin, x_axis, y_axis, normal


def _plane_line_angle(definition: dict, global_repo: Repository) -> tuple:
    """Plane that contains a line (hinge axis) and is rotated around that line by a given angle.

    At angle=0 the plane is oriented so its y_axis is perpendicular to the line and
    points in the direction most aligned with the world Z axis (or world X when the
    line is parallel to Z).  Increasing angle rotates the plane around the line.
    """
    line_str = definition.get('line', '')
    angle = float(definition.get('angle', 0.0))

    line_ref = global_repo.query(line_str)
    if line_ref is None:
        raise ValueError(f"line not found: {line_str!r}")

    line_start, line_end = _get_edge_3d(line_ref, global_repo)
    x_axis = _normalize(line_end - line_start)  # hinge axis = line direction
    origin = line_start.copy()

    # Build a reference y_axis perpendicular to x_axis (default at angle=0)
    if abs(x_axis[2]) < 0.9:
        ref = np.array([0.0, 0.0, 1.0])
    else:
        ref = np.array([1.0, 0.0, 0.0])
    y_axis_default = _normalize(ref - np.dot(ref, x_axis) * x_axis)

    # Rotate y_axis around x_axis by angle
    radians = math.radians(angle)
    z_axis_default = np.cross(x_axis, y_axis_default)
    y_axis = math.cos(radians) * y_axis_default + math.sin(radians) * z_axis_default
    normal = np.cross(x_axis, y_axis)
    return origin, x_axis, y_axis, normal


def _plane_offset(definition: dict, global_repo: Repository) -> tuple:
    """Plane parallel to a reference plane, offset along its normal."""
    plane_query = definition.get('plane', '')
    offset = float(definition.get('offset', 0.0))
    plane = global_repo.query(plane_query)
    if plane is None:
        raise ValueError(f"plane not found: {plane_query!r}")
    normal = np.array(plane.get('normal', [0, 0, 1]))
    origin = np.array(plane.get('origin', [0, 0, 0])) + normal * offset
    x_axis = np.array(plane.get('x_axis', [1, 0, 0]))
    y_axis = np.array(plane.get('y_axis', [0, 1, 0]))
    return origin, x_axis, y_axis, normal


def _solve_plane(feature: dict, global_repo: Repository) -> dict:
    """Solve a plane feature, computing a 3D coordinate frame."""
    try:
        definition = feature.get('definition', {})
        mode = definition.get('mode')

        if mode == 'three_point':
            origin, x_axis, y_axis, normal = _plane_three_point(definition, global_repo)
        elif mode == 'through_point':
            origin, x_axis, y_axis, normal = _plane_through_point(definition, global_repo)
        elif mode == 'line_angle':
            origin, x_axis, y_axis, normal = _plane_line_angle(definition, global_repo)
        elif mode == 'on_face':
            origin, x_axis, y_axis, normal = _plane_on_face(definition, global_repo)
        elif mode == 'on_face_edge_angle':
            origin, x_axis, y_axis, normal = _plane_on_face_edge_angle(definition, global_repo)
        elif mode == 'edge_point':
            origin, x_axis, y_axis, normal = _plane_edge_point(definition, global_repo)
        elif mode == 'offset':
            origin, x_axis, y_axis, normal = _plane_offset(definition, global_repo)
        else:
            return {'status': 'exception', 'message': f'unknown plane mode: {mode!r}'}

        rotation = feature.get('rotation', 0.0)
        if rotation != 0.0:
            x_axis, y_axis = _rotate_frame_around_normal(x_axis, y_axis, normal, rotation)

        plane_id = feature['id']
        global_repo.register(plane_id, {
            'type': 'plane',
            'origin': origin.tolist(),
            'x_axis': x_axis.tolist(),
            'y_axis': y_axis.tolist(),
            'normal': normal.tolist(),
        })

        return {
            'status': 'ok',
            'plane': {
                'origin': origin.tolist(),
                'x_axis': x_axis.tolist(),
                'y_axis': y_axis.tolist(),
                'normal': normal.tolist(),
            }
        }
    except Exception as e:
        return {'status': 'exception', 'message': str(e)}


def _solve_extrude(feature: dict, global_repo: Repository) -> dict:
    """Minimal extrude solver: generates top/bottom faces for topology references."""
    try:
        sketch_ref = feature.get('sketch', '')
        depth = float(feature.get('depth', 1.0))
        feature_id = feature['id']

        sketch_id = sketch_ref.lstrip('$')
        pt = global_repo.elements.get('_pt_' + sketch_id)
        if pt is None:
            return {'status': 'exception', 'message': f'sketch {sketch_id!r} not found'}

        origin = np.array(pt['origin'])
        x_axis = np.array(pt['x_axis'])
        y_axis = np.array(pt['y_axis'])
        normal = np.array(pt['normal'])

        topo = global_repo.elements.get('_topo_' + sketch_id, {})
        surfaces = topo.get('surfaces', []) if topo else []

        if surfaces:
            pts_2d = []
            for edge in surfaces[0]['boundary']:
                for key in ('start', 'end'):
                    if key in edge:
                        pts_2d.append(edge[key])
            if pts_2d:
                u = sum(p[0] for p in pts_2d) / len(pts_2d)
                v = sum(p[1] for p in pts_2d) / len(pts_2d)
            else:
                u, v = 0.0, 0.0
        else:
            u, v = 0.0, 0.0

        sketch_centroid = origin + u * x_axis + v * y_axis
        top_centroid = sketch_centroid + normal * depth

        global_repo.register(feature_id + "/top_face", {
            'type': 'face',
            'centroid': top_centroid.tolist(),
            'normal': normal.tolist(),
            'origin': top_centroid.tolist(),
            'x_axis': x_axis.tolist(),
            'y_axis': y_axis.tolist(),
        })

        # Register first edge of top face for on_face_edge_angle mode
        if surfaces and surfaces[0]['boundary']:
            edge = surfaces[0]['boundary'][0]
            if 'start' in edge and 'end' in edge:
                s2d, e2d = edge['start'], edge['end']
                s3d = (origin + s2d[0] * x_axis + s2d[1] * y_axis + normal * depth).tolist()
                e3d = (origin + e2d[0] * x_axis + e2d[1] * y_axis + normal * depth).tolist()
                global_repo.register(feature_id + "/top_face/edge0", {
                    'type': 'edge',
                    'start': s3d,
                    'end': e3d,
                })

        return {'status': 'ok'}
    except Exception as e:
        return {'status': 'exception', 'message': str(e)}


def _expand_center_rect(feature: dict) -> dict:
    """Return a copy of feature with center_rect entities expanded to 4 line entities."""
    initial = dict(feature.get("initial", {}))
    expanded: list = []
    for e in feature.get("entities", []):
        if e.get("kind") == "center_rect":
            cx, cy = e.get("xy", [0.0, 0.0])
            w, h = e.get("size", [1.0, 1.0])
            hw, hh = w / 2.0, h / 2.0
            eid = e["id"]
            tops = [
                {"id": eid + "_top",    "kind": "line"},
                {"id": eid + "_right",  "kind": "line"},
                {"id": eid + "_bottom", "kind": "line"},
                {"id": eid + "_left",   "kind": "line"},
            ]
            expanded.extend(tops)
            initial.setdefault(eid + "_top",    [cx - hw, cy + hh, cx + hw, cy + hh])
            initial.setdefault(eid + "_right",  [cx + hw, cy + hh, cx + hw, cy - hh])
            initial.setdefault(eid + "_bottom", [cx + hw, cy - hh, cx - hw, cy - hh])
            initial.setdefault(eid + "_left",   [cx - hw, cy - hh, cx - hw, cy + hh])
        else:
            expanded.append(e)
    result = dict(feature)
    result["entities"] = expanded
    result["initial"] = initial
    return result


def _solve_sketch(feature: dict, global_repo: Optional[Repository] = None) -> dict:
    # Expand compound entity kinds before processing.
    if any(e.get("kind") == "center_rect" for e in feature.get("entities", [])):
        feature = _expand_center_rect(feature)

    entities = {e["id"]: e for e in feature["entities"]}
    initial = dict(feature.get("initial", {}))
    constraints = list(feature.get("constraints", []))

    # Pre-compute projected entity parameters and add implicit fixed constraints.
    _projected_ids: set = set()
    if global_repo is not None:
        target_plane = _resolve_plane_early(feature.get("plane"), global_repo)
        for entity in feature.get("entities", []):
            kind = entity.get("kind", "")
            if kind in _PROJECTED_KINDS:
                eid = entity["id"]
                source_query = entity.get("source", "")
                try:
                    proj_params = _project_source_to_params(kind, source_query, target_plane, global_repo)
                    initial[eid] = proj_params
                    constraints.append({
                        "id": f"__proj_{eid}__",
                        "kind": "fixed",
                        "target": {"entity": eid},
                    })
                    _projected_ids.add(eid)
                except Exception:
                    pass  # leave initial as-is if projection fails

    # Inject the projected origin point — always present at (0, 0), not user-editable.
    entities[ORIGIN_ID] = {"id": ORIGIN_ID, "kind": "point", "projected": True}

    entity_offsets: dict = {}
    params: list = []
    for eid, entity in entities.items():
        entity_offsets[eid] = len(params)
        size = ENTITY_SIZES[entity["kind"]]
        params.extend(initial.get(eid, [0.0] * size))

    # Build a query Repository so constraints can reference entities by query string.
    # Sub-elements are registered with their canonical names appended to the entity id.
    feature_id = feature.get("id", "")
    repo = Repository()

    # Register globally available built-in entities (queried via @builtin_... syntax).
    # @builtin_origin resolves to the injected _origin entity so YAML constraints
    # that reference "@builtin_origin" work correctly.
    repo.register("builtin_origin",      {"entity": ORIGIN_ID, "point": "xy"})
    repo.register("builtin_plane_front", {"type": "plane", "origin": [0, 0, 0], "x_axis": [1, 0, 0], "y_axis": [0, 1, 0],  "normal": [0, 0, 1]})
    repo.register("builtin_plane_top",   {"type": "plane", "origin": [0, 0, 0], "x_axis": [1, 0, 0], "y_axis": [0, 0, -1], "normal": [0, 1, 0]})
    repo.register("builtin_plane_right", {"type": "plane", "origin": [0, 0, 0], "x_axis": [0, 0, -1], "y_axis": [0, 1, 0], "normal": [1, 0, 0]})

    for eid, entity in entities.items():
        kind = entity["kind"]
        repo.register(feature_id + eid, {"entity": eid})
        if kind == "line":
            repo.register(feature_id + eid + "start", {"entity": eid, "point": "start"})
            repo.register(feature_id + eid + "end",   {"entity": eid, "point": "end"})
        elif kind == "circle":
            repo.register(feature_id + eid + "center", {"entity": eid, "point": "center"})
        elif kind == "arc":
            repo.register(feature_id + eid + "start",  {"entity": eid, "point": "start"})
            repo.register(feature_id + eid + "end",    {"entity": eid, "point": "end"})
            repo.register(feature_id + eid + "center", {"entity": eid, "point": "center"})
        elif kind == "point":
            repo.register(feature_id + eid + "xy", {"entity": eid, "point": "xy"})

    def resolve_ref(val):
        """Resolve a constraint field value to {entity, point?} or {external_xy: [x,y]}.
        Accepts either a query string (new format) or an existing dict (old format).
        Falls back to global_repo for cross-sketch @absolute references."""
        if isinstance(val, str):
            result = repo.query(val, context=feature_id)
            if result is None and global_repo is not None:
                result = global_repo.query(val, context=feature_id)
            return result
        return val  # already a dict — backward compat with old {entity: ...} format

    # Resolve plane reference; default to front plane when absent or unresolvable.
    plane_query = feature.get("plane")
    if plane_query:
        plane_obj = resolve_ref(plane_query)
        # If unresolved and starts with '$', try direct feature-level lookup in global_repo.
        if (plane_obj is None or plane_obj.get("type") not in ("plane", "face")) \
                and plane_query.startswith("$") and global_repo is not None:
            plane_obj = global_repo.elements.get(plane_query[1:])
        if plane_obj is None or plane_obj.get("type") not in ("plane", "face"):
            plane_obj = _FRONT_PLANE
    else:
        plane_obj = _FRONT_PLANE

    _REF_FIELDS = ("target", "line", "arc", "point", "a", "b", "point_a", "point_b")

    def _constraint_entity_ids(c: dict) -> list:
        """Return all local entity IDs referenced by a constraint.
        If a query string fails to resolve entirely, None is appended so the
        constraint is rejected by the filter. External cross-sketch refs
        (resolved to {external_xy: ...}) are not local entities and are skipped."""
        ids = []
        for key in _REF_FIELDS:
            val = c.get(key)
            if val is None:
                continue
            ref = resolve_ref(val)
            if isinstance(ref, dict) and "entity" in ref:
                ids.append(ref["entity"])
            elif isinstance(ref, dict) and "external_xy" in ref:
                pass  # cross-sketch fixed point — no local entity needed
            elif isinstance(ref, dict) and "external_params" in ref:
                pass  # cross-sketch entity body — no local entity needed
            elif isinstance(ref, dict) and ref.get("type") == "face":
                pass  # topology face — projected to external_xy during pre-resolve
            elif isinstance(val, str):
                # Truly unresolvable query string — treat as missing
                ids.append(None)
        return ids

    constraints = [
        c for c in constraints
        if all(eid in entities for eid in _constraint_entity_ids(c))
    ]

    # Pre-resolve all query strings to {entity, point?} dicts so the rest of
    # the solver (residuals, render) can use them without any further changes.
    def _pre_resolve(c: dict) -> dict:
        rc = dict(c)
        for field in _REF_FIELDS:
            if field in rc and isinstance(rc[field], str):
                resolved = resolve_ref(rc[field])
                if resolved is not None:
                    # Topology face: project world-space origin onto sketch 2D coords.
                    if isinstance(resolved, dict) and resolved.get("type") == "face":
                        face_origin = resolved.get("origin", [0, 0, 0])
                        sk_origin = plane_obj.get("origin", [0, 0, 0])
                        x_axis = plane_obj.get("x_axis", [1, 0, 0])
                        y_axis = plane_obj.get("y_axis", [0, 1, 0])
                        dp = [face_origin[i] - sk_origin[i] for i in range(3)]
                        u = sum(dp[i] * x_axis[i] for i in range(3))
                        v = sum(dp[i] * y_axis[i] for i in range(3))
                        resolved = {"external_xy": [u, v]}
                    rc[field] = resolved
        return rc

    constraints = [_pre_resolve(c) for c in constraints]

    # Implicit constraint: pin the projected origin to (0, 0).
    # This is appended AFTER pre-resolution; it uses an already-resolved dict directly.
    constraints.append({
        "id": ORIGIN_FIX_ID,
        "kind": "fixed",
        "target": {"entity": ORIGIN_ID, "point": "xy"},
        "x": 0.0,
        "y": 0.0,
    })

    x0 = np.array(params, dtype=np.float64)

    def get_params(x, eid):
        off = entity_offsets[eid]
        size = ENTITY_SIZES[entities[eid]["kind"]]
        return x[off:off + size]

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
            return np.array([cx + r * np.cos(np.radians(a_deg)),
                             cy + r * np.sin(np.radians(a_deg))])
        elif kind in ("point", "projected_point"):
            return ep[0:2]
        raise ValueError(f"Unknown kind: {kind!r}")

    def _radius_dir(x, arc_eid, arc_ref, contact_ep):
        """Normalized radius direction for normal/tangent/perpendicular constraints.
        For arcs: use stored angle. For circles: use current contact point position."""
        ep = get_params(x, arc_eid)
        if entities[arc_eid]["kind"] == "circle":
            rv = contact_ep - ep[0:2]
            rn = np.linalg.norm(rv)
            return rv / rn if rn > 1e-10 else np.array([1.0, 0.0])
        arc_pt = arc_ref.get("point", "start")
        a_deg = ep[3] if arc_pt != "end" else ep[4]
        return np.array([np.cos(np.radians(a_deg)), np.sin(np.radians(a_deg))])

    # Pre-compute (line_eid, circle_eid) -> endpoint ("start"/"end") for coincident
    # constraints that pin a specific line endpoint to a circle.  When a tangent
    # constraint covers the same pair we use perpendicularity at that endpoint
    # instead of also adding an end-on-circle residual (which would force BOTH
    # endpoints onto the circle, conflicting with length/position constraints).
    _line_circle_coincident: dict = {}
    for _c in constraints:
        if _c.get("kind") == "coincident" and "point" in _c.get("a", {}):
            _a, _b = _c["a"], _c["b"]
            _a_eid = _a.get("entity")
            _b_eid = _b.get("entity")
            if (_a_eid and _b_eid
                    and entities.get(_a_eid, {}).get("kind") == "line"
                    and entities.get(_b_eid, {}).get("kind") == "circle"
                    and "point" not in _b):
                _line_circle_coincident[(_a_eid, _b_eid)] = _a.get("point", "start")

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
                if (not a_external and not b_external
                        and "point" not in a_ref and "point" not in b_ref
                        and a_kind == "line" and b_kind == "line"):
                    # line-to-line collinear: both lines lie on the same infinite line
                    ea = get_params(x, a_eid)
                    eb = get_params(x, b_eid)
                    da = ea[2:4] - ea[0:2]
                    db = eb[2:4] - eb[0:2]
                    r.append(da[0] * db[1] - da[1] * db[0])  # parallel
                    n = np.sqrt(da[0]**2 + da[1]**2)
                    nx, ny = (-da[1] / n, da[0] / n) if n > 0 else (0.0, 1.0)
                    r.append((eb[0] - ea[0]) * nx + (eb[1] - ea[1]) * ny)
                elif not b_external and "point" not in b_ref and b_kind == "line":
                    # point on line: perpendicular distance = 0
                    pa = get_point(x, a_ref)
                    ep_b = get_params(x, b_eid)
                    dx, dy = ep_b[2] - ep_b[0], ep_b[3] - ep_b[1]
                    n = np.sqrt(dx**2 + dy**2)
                    nx, ny = (-dy / n, dx / n) if n > 0 else (0.0, 1.0)
                    r.append((pa[0] - ep_b[0]) * nx + (pa[1] - ep_b[1]) * ny)
                elif not b_external and "point" not in b_ref and b_kind in ("circle", "arc"):
                    # point on circle/arc: distance from center = radius
                    pa = get_point(x, a_ref)
                    ep_b = get_params(x, b_eid)
                    dist = np.sqrt((pa[0] - ep_b[0])**2 + (pa[1] - ep_b[1])**2)
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
                    # Unnormalized: same zeros, avoids 1/|d| blowup for short lines
                    line_dir = line_ep[2:4] - line_ep[0:2]
                    contact = line_ep[2:4]
                    radius_dir = _radius_dir(x, arc_ref["entity"], arc_ref, contact)
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
                # Smooth normalization: avoids 1/|d| gradient blowup for short
                # lines while still preventing the trivial-zero at d=0.
                # d / sqrt(|d|^2 + eps^2): gradient bounded by 1/eps; zero iff d=0.
                _eps = 0.01
                line_dir = line_dir / np.sqrt(np.dot(line_dir, line_dir) + _eps * _eps)
                if entities[arc_ref["entity"]]["kind"] == "circle":
                    line_eid = line_ref["entity"]
                    arc_eid = arc_ref["entity"]
                    if (line_eid, arc_eid) in _line_circle_coincident:
                        # A coincident constraint already pins one line endpoint to
                        # the circle; that IS the tangent contact point.  Add only
                        # perpendicularity at that endpoint -- the on-circle condition
                        # is already handled by the coincident constraint, so we must
                        # not add another end-on-circle residual here.
                        pinned_pt = _line_circle_coincident[(line_eid, arc_eid)]
                        contact = line_ep[0:2] if pinned_pt == "start" else line_ep[2:4]
                        radius_dir = _radius_dir(x, arc_eid, arc_ref, contact)
                        r.append(np.dot(line_dir, radius_dir))
                    else:
                        # No coincident on this line+circle: pin end to circle and
                        # enforce perpendicularity there (standard tangent-at-end
                        # behavior).
                        contact = line_ep[2:4]
                        radius_dir = _radius_dir(x, arc_ref["entity"], arc_ref, contact)
                        r.append(np.dot(line_dir, radius_dir))
                        dist = np.sqrt((contact[0] - arc_ep[0])**2 + (contact[1] - arc_ep[1])**2)
                        r.append(dist - arc_ep[2])
                else:
                    contact = line_ep[2:4]
                    radius_dir = _radius_dir(x, arc_ref["entity"], arc_ref, contact)
                    # perpendicularity: line direction dot radius direction == 0
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
    topology = detect_topology(geom_solved, feature_id=feature_id)
    for vid, pt in topology['intersection_points'].items():
        geom_solved[vid] = {'x': pt['x'], 'y': pt['y'], 'intersection': True}

    # Per-entity status via null-space analysis.
    # The null space of J encodes all unconstrained directions. We project out
    # the 3 rigid-body modes (translation x/y, rotation) so that a freely
    # floating but shape-determined sketch doesn't flag its entities as free.
    entity_status = _entity_status(
        J, rank, entities, entity_offsets, n_params, status)

    # Per-constraint residual (sum of squares), render data, and superfluous flag.
    # A constraint is superfluous when removing its Jacobian rows does not reduce
    # the rank — i.e. it is linearly dependent on the remaining constraints.
    # The implicit origin-fix constraint is excluded from this analysis and output.
    constraint_row_ranges: list[tuple[str, int, int]] = []
    origin_fix_rows: set[int] = set()
    row_idx = 0
    for c in constraints:
        r_vec = residuals(x_sol, [c])
        n = len(r_vec)
        if c["id"] == ORIGIN_FIX_ID:
            origin_fix_rows = set(range(row_idx, row_idx + n))
        else:
            constraint_row_ranges.append((c["id"], row_idx, row_idx + n))
        row_idx += n

    # Greedy superfluous detection: iterate constraints in order; a constraint is
    # superfluous if its rows can be dropped from the *currently active* Jacobian
    # without reducing rank.  Using a greedy approach (rather than testing against
    # the full J) ensures at most one of a pair of identical constraints is flagged,
    # so the retained set always stays sufficient to constrain the sketch.
    # Origin-fix rows are always retained so they never inflate user-constraint rank.
    superfluous_ids: set[str] = set()
    if J.shape[0] > 0:
        active_rows = [r for r in range(J.shape[0]) if r not in origin_fix_rows]
        for cid, start, end in constraint_row_ranges:
            crows = list(range(start, end))
            remaining = [r for r in active_rows if r not in crows]
            J_active = J[active_rows + list(origin_fix_rows), :]
            J_remaining = J[remaining + list(origin_fix_rows), :]
            if int(np.linalg.matrix_rank(J_remaining, tol=RANK_TOL)) == int(np.linalg.matrix_rank(J_active, tol=RANK_TOL)):
                superfluous_ids.add(cid)
                active_rows = remaining

    constraints_out = {}
    for c in constraints:
        if c["id"] == ORIGIN_FIX_ID:
            continue  # internal — never expose to the frontend
        r_vec = residuals(x_sol, [c])
        constraints_out[c["id"]] = {
            "residual": round(float(np.sum(r_vec**2)), 12),
            "render": _constraint_render(c, geom_solved),
            "superfluous": c["id"] in superfluous_ids,
        }

    # Split geometry: user entities go to "geometry", projected entities to "projected".
    user_entities = {eid: e for eid, e in entities.items() if not e.get("projected")}
    projected_entities = {eid: e for eid, e in entities.items() if e.get("projected")}

    geometry_flat = _params_from_array(x_sol, user_entities, entity_offsets)
    projected_flat = _params_from_array(x_sol, projected_entities, entity_offsets)

    # Convert entity_status to features format, excluding projected entities.
    features = {eid: {"status": st} for eid, st in entity_status.items()
                if not entities.get(eid, {}).get("projected")}

    return {
        "status": status,
        "geometry": geometry_flat,
        "projected": projected_flat,
        "features": features,
        "topology": topology,
        "constraints": constraints_out,
        "plane_transform": _plane_transform(plane_obj),
    }
