import math
import os
import re
import time
from typing import Any, Optional
import yaml
import numpy as np
from scipy.optimize import least_squares
from oversolved.topology import detect_topology
from oversolved.query import Repository, _parse_ancestry, make_ancestry_query


def _init_global_repo() -> Repository:
    """Create and populate the global repository with built-in planes and origin."""
    repo = Repository()
    repo.register("builtin_origin", {"external_xy": [0.0, 0.0]})
    repo.register(
        "builtin_plane_front",
        {
            "type": "plane",
            "origin": [0, 0, 0],
            "x_axis": [1, 0, 0],
            "y_axis": [0, 1, 0],
            "normal": [0, 0, 1],
        },
    )
    repo.register(
        "builtin_plane_top",
        {
            "type": "plane",
            "origin": [0, 0, 0],
            "x_axis": [1, 0, 0],
            "y_axis": [0, 0, -1],
            "normal": [0, 1, 0],
        },
    )
    repo.register(
        "builtin_plane_right",
        {
            "type": "plane",
            "origin": [0, 0, 0],
            "x_axis": [0, 0, -1],
            "y_axis": [0, 1, 0],
            "normal": [1, 0, 0],
        },
    )
    return repo


def _clear_feature_geometry_registrations(
    global_repo: Repository, feature_id: str
) -> None:
    """Remove all geometry registrations previously made for a feature.
    This prevents ghost references when entities are deleted and the
    feature is re-solved."""
    global_repo.clear_by_sketch_id(feature_id)


def _post_register(
    global_repo: Repository,
    feature_id: str,
    feature: dict,
    feature_result: dict,
) -> None:
    """Register solved state from feature_result into global_repo for downstream use."""
    if feature_result.get("status") == "exception":
        return
    _clear_feature_geometry_registrations(global_repo, feature_id)
    if "geometry" in feature_result:
        _register_solved_geometry_slash(
            global_repo, feature_id, feature, feature_result["geometry"]
        )
        # Also register in legacy format for backward compatibility with plane features
        # that query via feature_id+entity_id (no slash)
        if feature.get("kind") == "sketch":

            def to_flat_params(val):
                if not isinstance(val, dict):
                    return list(val)
                if "start" in val and "end" in val:
                    return list(val.get("start", [])) + list(val.get("end", []))
                if "center" in val and "radius" in val:
                    c = val.get("center", [0, 0])
                    r = val.get("radius", 0)
                    a0 = val.get("angle_start", 0)
                    a1 = val.get("angle_end", 0)
                    return [c[0], c[1], r, a0, a1]
                if "xy" in val:
                    return list(val.get("xy", []))
                return list(val)

            flat_geometry = {
                k: to_flat_params(v) for k, v in feature_result["geometry"].items()
            }
            _register_solved_geometry(global_repo, feature_id, feature, flat_geometry)
    if "plane_transform" in feature_result:
        pt = feature_result["plane_transform"]
        rot = pt["rotation"]
        global_repo.register(
            "_pt_" + feature_id,
            {
                "origin": pt["origin"],
                "x_axis": rot[0:3],
                "y_axis": rot[3:6],
                "normal": rot[6:9],
            },
        )
    if "topology" in feature_result:
        global_repo.register("_topo_" + feature_id, feature_result["topology"])
        pt = feature_result.get("plane_transform")
        if pt:
            rot = pt["rotation"]
            plane_obj = {
                "type": "face",
                "origin": pt["origin"],
                "x_axis": rot[0:3],
                "y_axis": rot[3:6],
                "normal": rot[6:9],
            }
            _register_topology_surfaces(
                global_repo, feature_result["topology"], plane_obj
            )
            _register_topology_edges(global_repo, feature_result["topology"], plane_obj)
            _register_topology_vertices(
                global_repo, feature_result["topology"], plane_obj, feature_id
            )
        _register_sketch_feature(global_repo, feature_id, feature_result)


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
RANK_TOL = 1e-6  # tolerance for numerical rank computation


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

    global_repo = _init_global_repo()

    t0 = time.perf_counter()
    result = {}
    body_store: dict = {}
    for feature in features:
        feature_result = _try_solve_feature(feature, global_repo, body_store)
        result[feature["id"]] = feature_result
        _post_register(global_repo, feature["id"], feature, feature_result)

    total_ms = round((time.perf_counter() - t0) * 1000, 1)
    # Add builtin planes to result so frontend can access them consistently
    result["builtin_plane_front"] = {
        "status": "ok",
        "plane": {
            "origin": [0, 0, 0],
            "x_axis": [1, 0, 0],
            "y_axis": [0, 1, 0],
            "normal": [0, 0, 1],
        },
    }
    result["builtin_plane_top"] = {
        "status": "ok",
        "plane": {
            "origin": [0, 0, 0],
            "x_axis": [1, 0, 0],
            "y_axis": [0, 0, -1],
            "normal": [0, 1, 0],
        },
    }
    result["builtin_plane_right"] = {
        "status": "ok",
        "plane": {
            "origin": [0, 0, 0],
            "x_axis": [0, 0, -1],
            "y_axis": [0, 1, 0],
            "normal": [1, 0, 0],
        },
    }
    return {"solve_ms": total_ms, "result": result}


def solve_features(spec: dict) -> dict:
    """Solve a spec dict and return results as a list indexed by feature position.

    Returns {'features': [result_per_feature, ...]}.
    Results for plane features include 'plane' key; sketches include 'geometry'.
    """
    features = spec.get("features", [])

    global_repo = _init_global_repo()
    body_store: dict = {}

    results = []
    for feature in features:
        feature_result = _try_solve_feature(feature, global_repo, body_store)
        fid = feature.get("id", "")

        # Convert flat-params geometry to rich dict format for solve_features callers.
        if "geometry" in feature_result and feature.get("kind") == "sketch":
            feature_result = dict(feature_result)
            feature_result["geometry"] = _enrich_geometry(
                feature_result["geometry"], feature
            )

        results.append(feature_result)
        _post_register(global_repo, fid, feature, feature_result)

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
            rich[eid] = {
                "center": [float(cx), float(cy)],
                "radius": float(r),
                "angle_start": float(a0),
                "angle_end": float(a1),
            }
        elif kind == "point":
            rich[eid] = {"xy": list(params[0:2])}
        elif kind == "projected_line":
            rich[eid] = {
                "start": list(params[0:2]),
                "end": list(params[2:4]),
                "projected": True,
            }
        elif kind == "projected_circle":
            rich[eid] = {
                "center": list(params[0:2]),
                "radius": float(params[2]),
                "projected": True,
            }
        elif kind == "projected_arc":
            cx, cy, r, a0, a1 = params
            rich[eid] = {
                "center": [float(cx), float(cy)],
                "radius": float(r),
                "angle_start": float(a0),
                "angle_end": float(a1),
                "projected": True,
            }
        elif kind == "projected_point":
            rich[eid] = {"xy": list(params[0:2]), "projected": True}
        else:
            rich[eid] = list(params)
    return rich


def _register_solved_geometry_slash(
    global_repo: Repository, feature_id: str, feature: dict, geometry: dict
) -> None:
    """Register solved geometry using slash-separated query paths (@feature/entity/sub).
    Accepts both flat-params and rich-dict geometry formats."""
    entities = {e["id"]: e for e in feature.get("entities", [])}
    for eid, val in geometry.items():
        entity = entities.get(eid)
        if entity is None:
            continue
        kind = entity["kind"]
        prefix = feature_id + "/" + eid
        concat_prefix = feature_id + eid
        # Normalize to flat params for registration
        if isinstance(val, dict):
            if kind in ("line", "projected_line"):
                params = list(val.get("start", [0, 0])) + list(val.get("end", [0, 0]))
            elif kind in ("circle", "projected_circle"):
                params = list(val.get("center", [0, 0])) + [val.get("radius", 0)]
            elif kind in ("arc", "projected_arc"):
                cx, cy = val.get("center", [0, 0])
                params = [
                    cx,
                    cy,
                    val.get("radius", 0),
                    val.get("angle_start", 0),
                    val.get("angle_end", 0),
                ]
            elif kind in ("point", "projected_point"):
                params = list(val.get("xy", [0, 0]))
            else:
                continue
        else:
            params = list(val)
        global_repo.register(
            prefix, {"external_params": params, "kind": kind, "sketch_id": feature_id}
        )
        global_repo.register(
            concat_prefix,
            {"external_params": params, "kind": kind, "sketch_id": feature_id},
        )
        if kind in ("line", "projected_line"):
            global_repo.register(
                prefix + "/start",
                {"external_xy": list(params[0:2]), "sketch_id": feature_id},
            )
            global_repo.register(
                prefix + "/end",
                {"external_xy": list(params[2:4]), "sketch_id": feature_id},
            )
            global_repo.register(
                concat_prefix + "start",
                {"external_xy": list(params[0:2]), "sketch_id": feature_id},
            )
            global_repo.register(
                concat_prefix + "end",
                {"external_xy": list(params[2:4]), "sketch_id": feature_id},
            )
        elif kind in ("circle", "projected_circle"):
            global_repo.register(
                prefix + "/center",
                {"external_xy": list(params[0:2]), "sketch_id": feature_id},
            )
            global_repo.register(
                concat_prefix + "center",
                {"external_xy": list(params[0:2]), "sketch_id": feature_id},
            )
        elif kind in ("arc", "projected_arc"):
            cx, cy, r = params[0], params[1], params[2]
            a_start, a_end = params[3], params[4]
            global_repo.register(
                prefix + "/start",
                {
                    "external_xy": [
                        cx + r * math.cos(math.radians(a_start)),
                        cy + r * math.sin(math.radians(a_start)),
                    ],
                    "sketch_id": feature_id,
                },
            )
            global_repo.register(
                prefix + "/end",
                {
                    "external_xy": [
                        cx + r * math.cos(math.radians(a_end)),
                        cy + r * math.sin(math.radians(a_end)),
                    ],
                    "sketch_id": feature_id,
                },
            )
            global_repo.register(
                prefix + "/center", {"external_xy": [cx, cy], "sketch_id": feature_id}
            )
            global_repo.register(
                concat_prefix + "start",
                {
                    "external_xy": [
                        cx + r * math.cos(math.radians(a_start)),
                        cy + r * math.sin(math.radians(a_start)),
                    ],
                    "sketch_id": feature_id,
                },
            )
            global_repo.register(
                concat_prefix + "end",
                {
                    "external_xy": [
                        cx + r * math.cos(math.radians(a_end)),
                        cy + r * math.sin(math.radians(a_end)),
                    ],
                    "sketch_id": feature_id,
                },
            )
            global_repo.register(
                concat_prefix + "center",
                {"external_xy": [cx, cy], "sketch_id": feature_id},
            )
        elif kind in ("point", "projected_point"):
            global_repo.register(
                prefix + "/xy",
                {"external_xy": list(params[0:2]), "sketch_id": feature_id},
            )
            global_repo.register(
                concat_prefix + "xy",
                {"external_xy": list(params[0:2]), "sketch_id": feature_id},
            )


def _register_solved_geometry(
    global_repo: Repository, feature_id: str, feature: dict, geometry: dict
) -> None:
    """Register solved geometry from a sketch into the global repo as fixed external references."""
    entities = {e["id"]: e for e in feature.get("entities", [])}
    for eid, params in geometry.items():
        entity = entities.get(eid)
        if entity is None:
            continue
        kind = entity["kind"]
        global_repo.register(
            feature_id + eid,
            {"external_params": params, "kind": kind, "sketch_id": feature_id},
        )
        if kind == "line":
            global_repo.register(
                feature_id + eid + "start",
                {"external_xy": list(params[0:2]), "sketch_id": feature_id},
            )
            global_repo.register(
                feature_id + eid + "end",
                {"external_xy": list(params[2:4]), "sketch_id": feature_id},
            )
        elif kind == "circle":
            global_repo.register(
                feature_id + eid + "center",
                {"external_xy": list(params[0:2]), "sketch_id": feature_id},
            )
        elif kind == "arc":
            cx, cy, r = params[0], params[1], params[2]
            a_start, a_end = params[3], params[4]
            global_repo.register(
                feature_id + eid + "start",
                {
                    "external_xy": [
                        cx + r * math.cos(math.radians(a_start)),
                        cy + r * math.sin(math.radians(a_start)),
                    ],
                    "sketch_id": feature_id,
                },
            )
            global_repo.register(
                feature_id + eid + "end",
                {
                    "external_xy": [
                        cx + r * math.cos(math.radians(a_end)),
                        cy + r * math.sin(math.radians(a_end)),
                    ],
                    "sketch_id": feature_id,
                },
            )
            global_repo.register(
                feature_id + eid + "center",
                {"external_xy": [cx, cy], "sketch_id": feature_id},
            )
        elif kind == "point":
            global_repo.register(
                feature_id + eid + "xy",
                {"external_xy": list(params[0:2]), "sketch_id": feature_id},
            )


def _plane_transform(plane_obj: dict) -> dict:
    """Convert a plane object (x_axis, y_axis, normal, origin) to a plane_transform dict."""
    x_axis = plane_obj.get("x_axis", [1, 0, 0])
    y_axis = plane_obj.get("y_axis", [0, 1, 0])
    normal = plane_obj.get("normal", [0, 0, 1])
    origin = plane_obj.get("origin", [0, 0, 0])
    return {
        "rotation": list(x_axis) + list(y_axis) + list(normal),
        "origin": list(origin),
    }


def _register_topology_surfaces(
    global_repo: Repository, topology: dict, plane_obj: dict
) -> None:
    """Register each topology surface as a face-typed plane in the global repository."""
    x_axis = plane_obj["x_axis"]
    y_axis = plane_obj["y_axis"]
    normal = plane_obj["normal"]
    origin = plane_obj["origin"]

    for surface in topology.get("surfaces", []):
        query = surface.get("query")
        if not query or not query.startswith("?"):
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
        global_repo.register_anchestor(
            ids,
            {
                "type": "flatface",
                "origin": world_origin,
                "x_axis": list(x_axis),
                "y_axis": list(y_axis),
                "normal": list(normal),
            },
        )


def _register_topology_edges(
    global_repo: Repository, topology: dict, plane_obj: dict
) -> None:
    """Register each topology edge with its ancestry query."""
    x_axis = plane_obj["x_axis"]
    y_axis = plane_obj["y_axis"]
    origin = plane_obj["origin"]

    for edge in topology.get("edges", []):
        query = edge.get("query")
        if not query or not query.startswith("?"):
            continue

        start_2d = edge.get("start", [0, 0])
        end_2d = edge.get("end", [0, 0])

        world_start = [
            origin[0] + start_2d[0] * x_axis[0] + start_2d[1] * y_axis[0],
            origin[1] + start_2d[0] * x_axis[1] + start_2d[1] * y_axis[1],
            origin[2] + start_2d[0] * x_axis[2] + start_2d[1] * y_axis[2],
        ]
        world_end = [
            origin[0] + end_2d[0] * x_axis[0] + end_2d[1] * y_axis[0],
            origin[1] + end_2d[0] * x_axis[1] + end_2d[1] * y_axis[1],
            origin[2] + end_2d[0] * x_axis[2] + end_2d[1] * y_axis[2],
        ]

        edge_type = "straightedge" if edge.get("kind", "line") == "line" else "edge"
        edge_data = {
            "type": edge_type,
            "kind": edge.get("kind", "line"),
            "start": world_start,
            "end": world_end,
        }

        if "center" in edge:
            cx_2d, cy_2d = edge["center"]
            edge_data["center"] = [
                origin[0] + cx_2d * x_axis[0] + cy_2d * y_axis[0],
                origin[1] + cx_2d * x_axis[1] + cy_2d * y_axis[1],
                origin[2] + cx_2d * x_axis[2] + cy_2d * y_axis[2],
            ]
            edge_data["radius"] = edge["radius"]

        ids, _ = _parse_ancestry(query)
        global_repo.register_anchestor(ids, edge_data)


def _register_sketch_feature(
    global_repo: Repository, feature_id: str, feature_result: dict
) -> None:
    """Register the sketch feature itself as a sketch-feature entity."""
    if not feature_id or "topology" not in feature_result:
        return
    global_repo.register_anchestor(
        [f"@{feature_id}"],
        {"type": "sketch-feature", "feature_id": feature_id},
    )


def _register_topology_vertices(
    global_repo: Repository, topology: dict, plane_obj: dict, feature_id: str = ""
) -> None:
    """Register each topology vertex with its ancestry query."""
    x_axis = plane_obj["x_axis"]
    y_axis = plane_obj["y_axis"]
    origin = plane_obj["origin"]

    all_vertices = {}
    all_vertices.update(topology.get("vertices", {}))
    all_vertices.update(topology.get("intersection_points", {}))

    for vid, v in all_vertices.items():
        xy_2d = [v.get("x", 0), v.get("y", 0)]
        world_xy = [
            origin[0] + xy_2d[0] * x_axis[0] + xy_2d[1] * y_axis[0],
            origin[1] + xy_2d[0] * x_axis[1] + xy_2d[1] * y_axis[1],
            origin[2] + xy_2d[0] * x_axis[2] + xy_2d[1] * y_axis[2],
        ]

        ancestor_ids = [vid, "vertex"]
        if feature_id:
            ancestor_ids.append(f"@{feature_id}")
        query = make_ancestry_query(ancestor_ids, "vertex")

        ids, _ = _parse_ancestry(query)
        global_repo.register_anchestor(
            ids,
            {
                "type": "vertex",
                "x": world_xy[0],
                "y": world_xy[1],
                "z": world_xy[2],
            },
        )


def _try_solve_feature(feature: Any, global_repo: Repository, body_store: dict, features_by_id: dict[str, dict] | None = None) -> dict:
    t0 = time.perf_counter()
    try:
        result = _solve_feature(feature, global_repo, body_store, features_by_id)
        result["solve_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        return result
    except Exception as e:
        return {
            "solve_ms": round((time.perf_counter() - t0) * 1000, 1),
            "status": "exception",
            "exception": str(e),
        }


def _solve_feature(feature: Any, global_repo: Repository, body_store: dict, features_by_id: dict[str, dict] | None = None) -> dict:
    kind = feature.get("kind")
    if kind == "sketch":
        feature_result = _solve_sketch(feature, global_repo)
        return feature_result
    if kind == "plane":
        return _solve_plane(feature, global_repo, body_store)
    if kind == "extrude":
        return _solve_extrude(feature, global_repo, body_store)
    if kind == "import_step":
        return _solve_import_step(feature, global_repo, body_store)
    if kind == "fillet":
        return _solve_fillet(feature, global_repo, body_store)
    if kind == "chamfer":
        return _solve_chamfer(feature, global_repo, body_store)
    if kind == "revolve":
        return _solve_revolve(feature, global_repo, body_store)
    if kind == "array":
        return _solve_array(feature, global_repo, body_store)
    if kind == "boolean":
        return _solve_boolean(feature, global_repo, body_store)
    if kind == "delete_body":
        return _solve_delete_body(feature, global_repo, body_store)
    if kind == "hole":
        return _solve_hole(feature, global_repo, body_store, features_by_id or {})
    if kind == "transform":
        return _solve_transform(feature, global_repo, body_store)
    raise Exception(f"unknown feature type: '{kind}'")


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------


def _geometry_from_array(x, entities: dict, entity_offsets: dict) -> dict[str, Any]:
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
                "center": [cx, cy],
                "radius": r,
                "angle_start": a0,
                "angle_end": a1,
                "start": [
                    cx + r * math.cos(math.radians(a0)),
                    cy + r * math.sin(math.radians(a0)),
                ],
                "end": [
                    cx + r * math.cos(math.radians(a1)),
                    cy + r * math.sin(math.radians(a1)),
                ],
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
                "start": [
                    cx + r * math.cos(math.radians(a0)),
                    cy + r * math.sin(math.radians(a0)),
                ],
                "end": [
                    cx + r * math.cos(math.radians(a1)),
                    cy + r * math.sin(math.radians(a1)),
                ],
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
    """Return [x, y] for a constraint point reference {entity, point?} or {external_xy: ...}."""
    if "external_xy" in ref:
        return ref["external_xy"]
    e = geom[ref["entity"]]
    pt = ref.get("point", "start")
    if "start" in e and "end" in e and "radius" in e:  # arc
        return e["start"] if pt != "end" else e["end"]
    elif "start" in e:  # line
        return e["end"] if pt == "end" else e["start"]
    elif "center" in e:  # circle
        return list(e["center"])
    else:  # point
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
            eid = c["a"].get("entity") or c["b"].get("entity") or ""
            return {"kind": "symbol_h", "at": at, "entity": eid}
        eid = c["target"].get("entity", "")
        if not eid:
            return {}  # external-only target, can't render
        e = geom[eid]
        at = [(e["start"][0] + e["end"][0]) / 2, (e["start"][1] + e["end"][1]) / 2]
        return {"kind": "symbol_h", "at": at, "entity": eid}

    elif kind == "vertical":
        if "a" in c:
            pa = _geom_point(geom, c["a"])
            pb = _geom_point(geom, c["b"])
            at = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]
            eid = c["a"].get("entity") or c["b"].get("entity") or ""
            return {"kind": "symbol_v", "at": at, "entity": eid}
        eid = c["target"].get("entity", "")
        if not eid:
            return {}  # external-only target, can't render
        e = geom[eid]
        at = [(e["start"][0] + e["end"][0]) / 2, (e["start"][1] + e["end"][1]) / 2]
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
            "entity": eid,
        }

    elif kind == "radius":
        eid = c["target"]["entity"]
        e = geom[eid]
        center = e["center"]
        edge = (
            e["start"]
            if "start" in e
            else [e["center"][0] + e["radius"], e["center"][1]]
        )
        return {
            "kind": "dim_radius",
            "p1": center,
            "p2": edge,
            "value": c["value"],
            "entity": eid,
        }

    elif kind == "diameter":
        eid = c["target"]["entity"]
        e = geom[eid]
        cx, cy, r = e["center"][0], e["center"][1], e["radius"]
        return {
            "kind": "dim_diameter",
            "p1": [cx - r, cy],
            "p2": [cx + r, cy],
            "value": c["value"],
            "entity": eid,
        }

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
            "entity": eid_a,
        }

    elif kind == "coincident":
        a_eid = c["a"]["entity"]
        ea = geom[a_eid]
        if (
            "point" not in c["a"]
            and "start" in ea
            and "start" in geom.get(c["b"]["entity"], {})
        ):
            # line-to-line collinear: place symbol at midpoint of a
            at = [
                (ea["start"][0] + ea["end"][0]) / 2,
                (ea["start"][1] + ea["end"][1]) / 2,
            ]
        else:
            at = _geom_point(geom, c["a"])
        return {"kind": "symbol_coincident", "at": at, "entity": a_eid}

    elif kind == "normal":
        ea_id = c["a"]["entity"]
        eb_id = c["b"]["entity"]
        ea = geom[ea_id]
        eb = geom[eb_id]
        if "center" in eb:
            pt = (
                eb["start"]
                if "start" in eb and c["b"].get("point", "start") != "end"
                else list(eb["center"])
            )
            return {"kind": "symbol_normal", "at": pt, "entity": eb_id}
        elif "center" in ea:
            pt = (
                ea["start"]
                if "start" in ea and c["a"].get("point", "start") != "end"
                else list(ea["center"])
            )
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
            "entity": eid,
        }

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
        at_a = [
            (ea["start"][0] + ea["end"][0]) / 2,
            (ea["start"][1] + ea["end"][1]) / 2,
        ]
        at_b = [
            (eb["start"][0] + eb["end"][0]) / 2,
            (eb["start"][1] + eb["end"][1]) / 2,
        ]
        return {"kind": "symbol_equal", "at_a": at_a, "at_b": at_b, "entity": eid}

    elif kind == "point_distance":
        pa = _geom_point(geom, c["a"])
        pb = _geom_point(geom, c["b"])
        dx, dy = pb[0] - pa[0], pb[1] - pa[1]
        n = math.hypot(dx, dy)
        normal = [-dy / n, dx / n] if n > 0 else [0.0, 1.0]
        eid = c["a"].get("entity") or c["b"].get("entity") or ""
        return {
            "kind": "dim_linear",
            "p1": pa,
            "p2": pb,
            "value": c["value"],
            "normal": normal,
            "entity": eid,
        }

    elif kind == "midpoint":
        if "line" in c:
            eid = c["line"]["entity"]
            e = geom[eid]
            at = [(e["start"][0] + e["end"][0]) / 2, (e["start"][1] + e["end"][1]) / 2]
        else:
            eid = c["point_a"]["entity"]
            pa = _geom_point(geom, c["point_a"])
            pb = _geom_point(geom, c["point_b"])
            at = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]
        return {
            "kind": "symbol_midpoint",
            "at": at,
            "axis": c.get("axis", "both"),
            "entity": eid,
        }

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
            "entity": eid,
        }

    return {"kind": "unknown"}


# ---------------------------------------------------------------------------
# Per-entity constraint status
# ---------------------------------------------------------------------------


def _entity_status(J, rank, entities, entity_offsets, n_params, overall_status):
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
_PLANE_TYPES = ("plane", "face", "flatface")
_POINT_TYPES = ("point", "vertex")


def is_plane_type(obj: dict) -> bool:
    return obj.get("type") in _PLANE_TYPES


def is_point_type(obj: dict) -> bool:
    return obj.get("type") in _POINT_TYPES


def _resolve_plane_early(
    plane_query: Optional[str], global_repo: Optional[Repository]
) -> dict:
    """Quick plane resolution without full repo setup (used before entity_offsets are built)."""
    _BARE_ID_MAP = {
        "Top": "builtin_plane_top",
        "Front": "builtin_plane_front",
        "Right": "builtin_plane_right",
    }
    if not plane_query:
        return _FRONT_PLANE
    if plane_query in _BARE_ID_MAP:
        return _BUILTIN_PLANES[_BARE_ID_MAP[plane_query]]
    if plane_query.startswith("@"):
        builtin = _BUILTIN_PLANES.get(plane_query[1:])
        if builtin is not None:
            return builtin
        # Also look up user-defined planes in global_repo (e.g. @plane1)
        if global_repo is not None:
            p = global_repo.elements.get(plane_query[1:])
            if p and is_plane_type(p):
                return p
        return _FRONT_PLANE
    if plane_query.startswith("?") and global_repo is not None:
        # Ancestry query -- resolves to a registered face (e.g. from a 3D body mesh)
        try:
            origin, x_axis, y_axis, normal = _plane_on_face(
                {"face": plane_query}, global_repo
            )
            return {
                "origin": origin.tolist(),
                "x_axis": x_axis.tolist(),
                "y_axis": y_axis.tolist(),
                "normal": normal.tolist(),
            }
        except (ValueError, KeyError, TypeError):
            pass
    if plane_query.startswith("$") and global_repo is not None:
        p = global_repo.elements.get(plane_query[1:])
        if p and is_plane_type(p):
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
                "end": _2d_to_3d(params[2:4], source_plane),
            }
        if kind == "circle":
            return "circle", {
                "center": _2d_to_3d(params[0:2], source_plane),
                "radius": params[2],
            }
        if kind == "arc":
            return "arc", {
                "center": _2d_to_3d(params[0:2], source_plane),
                "radius": params[2],
                "start_angle": params[3],
                "end_angle": params[4],
            }

    raise ValueError(f"cannot resolve source geometry for {source_query!r}")


def _project_source_to_params(
    projected_kind: str, source_query: str, target_plane: dict, global_repo: Repository
) -> list:
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
    Also accepts vertex objects (type == "vertex") and generic dicts with
    an "origin" field (but no "normal", which would indicate a plane).
    """
    if "external_xy" in ref:
        xy = ref["external_xy"]
        sketch_id = ref.get("sketch_id")
        if sketch_id:
            pt = global_repo.elements.get("_pt_" + sketch_id)
            if pt:
                origin = np.array(pt["origin"])
                x_axis = np.array(pt["x_axis"])
                y_axis = np.array(pt["y_axis"])
                return origin + xy[0] * x_axis + xy[1] * y_axis
        return np.array([xy[0], xy[1], 0.0])
    if ref.get("type") == "vertex" and "origin" in ref:
        return np.array(ref["origin"], dtype=float)
    if "origin" in ref and "normal" not in ref:
        return np.array(ref["origin"], dtype=float)
    if "origin" in ref and "normal" in ref:
        raise ValueError("reference is a plane, not a point")
    raise ValueError("point reference has no coordinates")


def _get_edge_3d(ref: dict, global_repo: Repository) -> tuple:
    """Return (start_3d, end_3d) for a registered edge/line reference.

    Uses sketch_id + _pt_ plane transform when available.
    Falls back to z=0 for 2D-only references.
    """
    if "external_params" in ref and ref.get("kind") in ("line", "projected_line"):
        p = ref["external_params"]
        sketch_id = ref.get("sketch_id")
        if sketch_id:
            pt = global_repo.elements.get("_pt_" + sketch_id)
            if pt:
                origin = np.array(pt["origin"])
                x_axis = np.array(pt["x_axis"])
                y_axis = np.array(pt["y_axis"])
                start = origin + p[0] * x_axis + p[1] * y_axis
                end = origin + p[2] * x_axis + p[3] * y_axis
                return start, end
        return np.array([p[0], p[1], 0.0]), np.array([p[2], p[3], 0.0])
    if "start" in ref and "end" in ref:
        return np.array(ref["start"]), np.array(ref["end"])
    raise ValueError("edge reference has no line coordinates")


def _normalize(v: np.ndarray) -> np.ndarray:
    """Return unit vector in direction of v."""
    n = np.linalg.norm(v)
    if n < 1e-12:
        raise ValueError("Cannot normalize zero-length vector")
    return v / n


def _rotate_frame_around_normal(
    x_axis: np.ndarray, y_axis: np.ndarray, normal: np.ndarray, degrees: float
) -> tuple:
    """Rotate x_axis and y_axis around normal by degrees (CW looking down normal)."""
    radians = np.radians(degrees)
    cos_a = np.cos(radians)
    sin_a = np.sin(radians)
    x_new = cos_a * x_axis + sin_a * y_axis
    y_new = -sin_a * x_axis + cos_a * y_axis
    return x_new, y_new


def _plane_three_point(definition: dict, global_repo: Repository) -> tuple:
    """Three-point plane: origin at p1, x_axis toward p2, y_axis toward p3 (Gram-Schmidt)."""
    r1 = global_repo.query(definition["p1"])
    r2 = global_repo.query(definition["p2"])
    r3 = global_repo.query(definition["p3"])
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


def _plane_on_face(definition: dict, global_repo: Repository, body_store: dict | None = None) -> tuple:
    """Plane aligned with a topology face."""
    face_str = definition["face"]
    face = global_repo.query(face_str, body_store=body_store)
    if face is None:
        raise ValueError(f"face not found: {face_str!r}")

    origin = np.array(face["centroid"])
    normal = np.array(face["normal"])

    if abs(normal[2]) < 0.9:
        arbitrary = np.array([0.0, 0.0, 1.0])
    else:
        arbitrary = np.array([1.0, 0.0, 0.0])

    x_axis = _normalize(np.cross(normal, arbitrary))
    y_axis = np.cross(normal, x_axis)
    return origin, x_axis, y_axis, normal


def _plane_on_face_edge_angle(definition: dict, global_repo: Repository, body_store: dict | None = None) -> tuple:
    """Plane on face with X axis along an edge, rotated by angle."""
    face_str = definition["face"]
    edge_str = definition["edge"]
    angle = definition.get("angle", 0.0)

    face = global_repo.query(face_str, body_store=body_store)
    if face is None:
        raise ValueError(f"face not found: {face_str!r}")
    edge = global_repo.query(edge_str, body_store=body_store)
    if edge is None:
        raise ValueError(f"edge not found: {edge_str!r}")

    origin = np.array(face["centroid"])
    normal = np.array(face["normal"])

    edge_dir = _normalize(np.array(edge["end"]) - np.array(edge["start"]))
    x_axis_base = edge_dir - np.dot(edge_dir, normal) * normal
    x_axis_base = _normalize(x_axis_base)

    x_axis, _ = _rotate_frame_around_normal(
        x_axis_base, np.cross(normal, x_axis_base), normal, angle
    )
    y_axis = np.cross(normal, x_axis)
    return origin, x_axis, y_axis, normal


def _plane_edge_point(definition: dict, global_repo: Repository, body_store: dict | None = None) -> tuple:
    """Plane with X axis along an edge and origin at a point.

    The plane's origin is at the given point, x_axis is along the line direction,
    and y_axis points from the point toward the line (perpendicular projection),
    making the plane pivot around the line.
    """
    edge_str = definition["edge"]
    point_str = definition["point"]

    edge = global_repo.query(edge_str, body_store=body_store)
    if edge is None:
        raise ValueError(f"edge not found: {edge_str!r}")
    point_ref = global_repo.query(point_str, body_store=body_store)
    if point_ref is None:
        raise ValueError(f"point not found: {point_str!r}")

    edge_start, edge_end = _get_edge_3d(edge, global_repo)
    x_axis = _normalize(edge_end - edge_start)
    origin = _get_point_3d(point_ref, global_repo)
    point_3d = origin

    # Project point onto the line
    t = float(np.dot(point_3d - edge_start, x_axis))
    projected_point = edge_start + x_axis * t

    # y_axis points from point toward its projection on the line
    point_to_projection = projected_point - point_3d
    if np.linalg.norm(point_to_projection) > 1e-10:
        y_axis = _normalize(point_to_projection)
    else:
        # Point is on the line, use perpendicular direction
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
    plane_query = definition.get("plane", "")
    point_query = definition.get("point", "")
    ref_plane = global_repo.query(plane_query)
    if ref_plane is None:
        raise ValueError(f"plane not found: {plane_query!r}")
    point_ref = global_repo.query(point_query)
    if point_ref is None:
        raise ValueError(f"point not found: {point_query!r}")

    normal = np.array(ref_plane.get("normal", [0, 0, 1]))
    x_axis = np.array(ref_plane.get("x_axis", [1, 0, 0]))
    y_axis = np.array(ref_plane.get("y_axis", [0, 1, 0]))
    ref_origin = np.array(ref_plane.get("origin", [0, 0, 0]))

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
    line_str = definition.get("line", "")
    angle = float(definition.get("angle", 0.0))

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
    plane_query = definition.get("plane") or definition.get("reference", "")
    offset = float(definition.get("offset") or definition.get("distance") or 0.0)
    plane = global_repo.query(plane_query)
    if plane is None:
        raise ValueError(f"plane not found: {plane_query!r}")
    normal = np.array(plane.get("normal", [0, 0, 1]))
    origin = np.array(plane.get("origin", [0, 0, 0])) + normal * offset
    x_axis = np.array(plane.get("x_axis", [1, 0, 0]))
    y_axis = np.array(plane.get("y_axis", [0, 1, 0]))
    return origin, x_axis, y_axis, normal


def _solve_plane(feature: dict, global_repo: Repository, body_store: dict | None = None) -> dict:
    """Solve a plane feature, computing a 3D coordinate frame."""
    try:
        definition = feature.get("definition", {})
        mode = definition.get("mode")

        if mode == "three_point":
            origin, x_axis, y_axis, normal = _plane_three_point(definition, global_repo)
        elif mode == "plane_point":
            origin, x_axis, y_axis, normal = _plane_through_point(
                definition, global_repo
            )
        elif mode == "line_angle":
            origin, x_axis, y_axis, normal = _plane_line_angle(definition, global_repo)
        elif mode == "on_face":
            origin, x_axis, y_axis, normal = _plane_on_face(definition, global_repo, body_store)
        elif mode == "on_face_edge_angle":
            origin, x_axis, y_axis, normal = _plane_on_face_edge_angle(
                definition, global_repo, body_store
            )
        elif mode == "edge_point":
            origin, x_axis, y_axis, normal = _plane_edge_point(definition, global_repo, body_store)
        elif mode == "offset":
            origin, x_axis, y_axis, normal = _plane_offset(definition, global_repo)
        else:
            return {"status": "exception", "exception": f"unknown plane mode: {mode!r}"}

        rotation = definition.get("rotation", 0.0)
        if rotation != 0.0:
            x_axis, y_axis = _rotate_frame_around_normal(
                x_axis, y_axis, normal, rotation
            )

        plane_id = feature["id"]
        global_repo.register(
            plane_id,
            {
                "type": "plane",
                "origin": origin.tolist(),
                "x_axis": x_axis.tolist(),
                "y_axis": y_axis.tolist(),
                "normal": normal.tolist(),
            },
        )

        return {
            "status": "ok",
            "plane": {
                "origin": origin.tolist(),
                "x_axis": x_axis.tolist(),
                "y_axis": y_axis.tolist(),
                "normal": normal.tolist(),
            },
        }
    except Exception as e:
        return {"status": "exception", "exception": str(e)}


_ARC_SEGMENTS = 32  # tessellation resolution for arc edges in profiles


def _tessellate_edge(edge: dict) -> list[list[float]]:
    """Return ordered 2D [u, v] sample points for a boundary edge (exclusive of start).

    For line edges returns just the end point.
    For arc edges returns ARC_SEGMENTS-proportional intermediate points plus the end.
    """
    import math

    kind = edge.get("kind", "line")
    end = edge.get("end")
    if kind == "arc":
        center = edge.get("center", [0, 0])
        radius = edge.get("radius", 1.0)
        a0 = edge.get("angle_start_deg", 0.0)
        a1 = edge.get("angle_end_deg", 360.0)
        ccw = edge.get("ccw", True)
        span = ((a1 - a0) + 360) % 360 if ccw else -(((a0 - a1) + 360) % 360)
        steps = max(4, int(abs(span) / 360 * _ARC_SEGMENTS))
        pts = []
        for i in range(1, steps + 1):
            a = (a0 + span * i / steps) * math.pi / 180
            pts.append(
                [center[0] + radius * math.cos(a), center[1] + radius * math.sin(a)]
            )
        return pts
    # line: just the endpoint
    if end is not None:
        return [list(end)]
    return []


def _extract_profile_loops(
    surfaces: list[dict],
    plane_transform: dict,
) -> list[list[dict]]:
    """Extract ordered boundary-edge loops from topology surfaces.

    Returns a list of loops where loops[0] is the outer boundary and
    loops[1:] are holes. Each loop is a list of edge dicts (kind, start, end,
    and arc fields where applicable), ordered so each edge's end connects to
    the next edge's start.
    Returns empty list if no closed surface is found.
    """
    if not surfaces:
        return []

    TOL = 1e-6

    def dist2d(a: list, b: list) -> float:
        return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5

    all_loops: list[list[dict]] = []
    for surface in surfaces:
        boundary = surface.get("boundary", [])
        if not boundary:
            continue

        # Build (start, end, edge_dict) triples; skip edges missing endpoints.
        raw_edges = []
        for e in boundary:
            s = e.get("start")
            en = e.get("end")
            if s is not None and en is not None:
                raw_edges.append((s, en, e))
        if len(raw_edges) < 1:
            continue

        used: set[int] = set()
        current = list(raw_edges[0][0])
        loop: list[dict] = []

        for _ in range(len(raw_edges)):
            found_next = False
            for i, (s, e, edict) in enumerate(raw_edges):
                if i in used:
                    continue
                forward = dist2d(current, s) <= TOL
                reverse = dist2d(current, e) <= TOL
                if forward or reverse:
                    if forward:
                        loop.append(edict)
                        current = list(e)
                    else:
                        # Reverse orientation: flip start/end and arc direction.
                        rev: dict = dict(edict)
                        rev["start"] = list(edict["end"])
                        rev["end"] = list(edict["start"])
                        if edict.get("kind") == "arc":
                            rev["angle_start_deg"] = edict.get("angle_end_deg", 0)
                            rev["angle_end_deg"] = edict.get("angle_start_deg", 0)
                            rev["ccw"] = not edict.get("ccw", True)
                        loop.append(rev)
                        current = list(s)
                    used.add(i)
                    found_next = True
                    break
            if not found_next:
                break
            if dist2d(list(raw_edges[0][0]), current) <= TOL and len(loop) >= 1:
                all_loops.append(loop)
                break

    return all_loops


def _register_top_face(
    global_repo: Repository,
    feature_id: str,
    pt: dict,
    surfaces: list[dict],
    distance: float,
) -> None:
    # Named topology: semantic names (top, bottom) are stable across re-solves.
    # Index-based names (side/N, edge/N) are fragile: they change if the sketch
    # profile gains or loses edges. Full Named Topology (OCC TNaming) is future work.
    origin = np.array(pt["origin"])
    x_axis = np.array(pt["x_axis"])
    y_axis = np.array(pt["y_axis"])
    normal = np.array(pt["normal"])

    if surfaces:
        pts_2d = []
        for edge in surfaces[0].get("boundary", []):
            for key in ("start", "end"):
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
    top_centroid = sketch_centroid + normal * distance
    top_plane_origin = (origin + normal * distance).tolist()

    global_repo.register(
        feature_id + "/top_face",
        {
            "type": "flatface",
            "centroid": top_centroid.tolist(),
            "normal": normal.tolist(),
            "origin": top_plane_origin,
            "x_axis": x_axis.tolist(),
            "y_axis": y_axis.tolist(),
        },
    )

    if surfaces and surfaces[0].get("boundary"):
        edge = surfaces[0]["boundary"][0]
        if "start" in edge and "end" in edge:
            s2d, e2d = edge["start"], edge["end"]
            s3d = (
                origin + s2d[0] * x_axis + s2d[1] * y_axis + normal * distance
            ).tolist()
            e3d = (
                origin + e2d[0] * x_axis + e2d[1] * y_axis + normal * distance
            ).tolist()
            global_repo.register(
                feature_id + "/top_face/edge0",
                {
                    "type": "straightedge",
                    "start": s3d,
                    "end": e3d,
                },
            )


def _extract_loops_from_occ_face(
    shape: Any, face_index: int
) -> tuple[list[list[dict]], dict]:
    """Extract boundary loops and effective plane from an OCC solid face by index.

    Returns (loops, plane_dict) in the same formats expected by extrude_profile.
    Raises ValueError if the face is not planar or index is out of range.
    """
    from OCP.BRepAdaptor import BRepAdaptor_Curve2d, BRepAdaptor_Surface  # noqa: PLC0415
    from OCP.BRepTools import BRepTools, BRepTools_WireExplorer  # noqa: PLC0415
    from OCP.GeomAbs import GeomAbs_Plane  # noqa: PLC0415
    from OCP.TopAbs import TopAbs_FACE, TopAbs_WIRE  # noqa: PLC0415
    from OCP.TopExp import TopExp_Explorer  # noqa: PLC0415
    from OCP.TopoDS import TopoDS, TopoDS_Face  # noqa: PLC0415

    topo_shape = shape.wrapped if hasattr(shape, "wrapped") else shape

    # Sort faces by (normal, centroid) to match the canonical ordering used in
    # solid_to_mesh, so face_index is consistent between tessellation and extraction.
    try:
        cq_shape = shape if hasattr(shape, "faces") else None
        if cq_shape is not None:
            faces = list(cq_shape.faces())

            def _face_sort_key(f):
                ub = f._uvBounds()
                n = f.normalAt((ub[0] + ub[1]) / 2, (ub[2] + ub[3]) / 2)[0]
                c = f.Center()
                return (round(n.x, 6), round(n.y, 6), round(n.z, 6),
                        round(c.x, 6), round(c.y, 6), round(c.z, 6))
            faces.sort(key=_face_sort_key)
            if face_index >= len(faces):
                raise ValueError(f"face_index {face_index} out of range")
            target_face = faces[face_index]
            occ_face = TopoDS_Face()
            occ_face.TShape(target_face.wrapped.TShape())
            occ_face.Location(target_face.wrapped.Location())
            occ_face.Orientation(target_face.wrapped.Orientation())
        else:
            explorer = TopExp_Explorer(topo_shape, TopAbs_FACE)
            for _ in range(face_index):
                if not explorer.More():
                    raise ValueError(f"face_index {face_index} out of range")
                explorer.Next()
            if not explorer.More():
                raise ValueError(f"face_index {face_index} out of range")
            face_shape = explorer.Current()
            occ_face = TopoDS_Face()
            occ_face.TShape(face_shape.TShape())
            occ_face.Location(face_shape.Location())
            occ_face.Orientation(face_shape.Orientation())
    except Exception:
        # Fallback to raw traversal if cadquery sorting fails.
        explorer = TopExp_Explorer(topo_shape, TopAbs_FACE)
        for _ in range(face_index):
            if not explorer.More():
                raise ValueError(f"face_index {face_index} out of range")
            explorer.Next()
        if not explorer.More():
            raise ValueError(f"face_index {face_index} out of range")
        face_shape = explorer.Current()
        occ_face = TopoDS_Face()
        occ_face.TShape(face_shape.TShape())
        occ_face.Location(face_shape.Location())
        occ_face.Orientation(face_shape.Orientation())

    adaptor = BRepAdaptor_Surface(occ_face, True)
    if adaptor.GetType() != GeomAbs_Plane:
        raise ValueError("Only flat faces can be used as extrude profiles")

    gp_pln = adaptor.Plane()
    ax3 = gp_pln.Position()
    loc = ax3.Location()
    xdir = ax3.XDirection()
    ydir = ax3.YDirection()
    ndir = ax3.Direction()

    effective_plane: dict = {
        "origin": [loc.X(), loc.Y(), loc.Z()],
        "x_axis": [xdir.X(), xdir.Y(), xdir.Z()],
        "y_axis": [ydir.X(), ydir.Y(), ydir.Z()],
        "normal": [ndir.X(), ndir.Y(), ndir.Z()],
    }

    outer_wire = BRepTools.OuterWire_s(occ_face)
    all_wires = [outer_wire]
    wire_exp = TopExp_Explorer(occ_face, TopAbs_WIRE)
    while wire_exp.More():
        w = TopoDS.Wire_s(wire_exp.Current())
        if not w.IsSame(outer_wire):
            all_wires.append(w)
        wire_exp.Next()

    loops: list[list[dict]] = []
    for wire in all_wires:
        loop: list[dict] = []
        we = BRepTools_WireExplorer(wire, occ_face)
        while we.More():
            edge = we.Current()
            try:
                c2d = BRepAdaptor_Curve2d(edge, occ_face)
                first = c2d.FirstParameter()
                last = c2d.LastParameter()
                p_s = c2d.Value(first)
                p_e = c2d.Value(last)
                loop.append({
                    "kind": "line",
                    "start": [p_s.X(), p_s.Y()],
                    "end": [p_e.X(), p_e.Y()],
                })
            except Exception:
                pass
            we.Next()
        if loop:
            loops.append(loop)

    return loops, effective_plane


def _resolve_face_profile(
    sketch_ref: str, global_repo: Repository, body_store: dict
) -> tuple[list[list[dict]], dict]:
    """Resolve a face reference (@/? prefixed) to profile loops and an effective plane.

    Handles two cases:
    - Ancestry query (?...): resolves to a B-rep face entry with body_id and face_index;
      extracts loops directly from the OCC solid via TopExp traversal.
    - Named query (@featureId/top_face): resolves to the registered flatface entry;
      uses the original sketch topology paired with the shifted plane origin.
    """
    def _find_body_for_feature(feat_id: str):
        body = body_store.get("body_" + feat_id)
        if body is not None and body.shape is not None:
            return body
        return next(
            (
                b for b in body_store.values()
                if getattr(b, "created_by", None) == feat_id and getattr(b, "shape", None) is not None
            ),
            None,
        )

    # Accept slash-style B-rep face IDs emitted by the 3D picker fallback:
    # @<feature_id>/face/<index>
    slash_match = re.fullmatch(r"@([^/]+)/face/(\d+)", sketch_ref)
    if slash_match:
        feat_id = slash_match.group(1)
        face_index = int(slash_match.group(2))
        body = _find_body_for_feature(feat_id)
        if body is None:
            raise ValueError(f"No body found for feature {feat_id!r}")
        return _extract_loops_from_occ_face(body.shape, face_index)

    face_entry = global_repo.query(sketch_ref, body_store=body_store)
    if face_entry is None:
        raise ValueError(f"Profile face not found: {sketch_ref!r}")

    body_id = face_entry.get("body_id")
    face_index = face_entry.get("face_index")
    if body_id is not None and face_index is not None:
        body = body_store.get(body_id)
        if body is None or body.shape is None:
            raise ValueError(f"Body {body_id!r} not found or has no shape")
        return _extract_loops_from_occ_face(body.shape, face_index)

    # Named registration (e.g. @featureId/top_face): derive sketch topology.
    if sketch_ref.startswith("@"):
        feat_id = sketch_ref[1:].split("/")[0]
        body = _find_body_for_feature(feat_id)
        if body is None:
            raise ValueError(f"No body found for feature {feat_id!r}")
        topo = global_repo.elements.get("_topo_" + body.sketch_id, {})
        surfaces = topo.get("surfaces", []) if topo else []
        effective_plane = {
            "origin": face_entry.get("origin", [0, 0, 0]),
            "x_axis": face_entry.get("x_axis", [1, 0, 0]),
            "y_axis": face_entry.get("y_axis", [0, 1, 0]),
            "normal": face_entry.get("normal", [0, 0, 1]),
        }
        sketch_pt = global_repo.elements.get("_pt_" + body.sketch_id) or effective_plane
        loops = _extract_profile_loops(surfaces, sketch_pt)
        return loops, effective_plane

    # Ancestry query (?...) resolving to a sketch surface (no body_id/face_index):
    # find the parent sketch from the ancestry IDs, then extract only the matched surface.
    if sketch_ref.startswith("?"):
        ids, _ = _parse_ancestry(sketch_ref)
        target_set = frozenset(ids)
        sketch_id = None
        for aid in ids:
            if aid.startswith("@"):
                candidate = aid[1:]
                if global_repo.elements.get("_pt_" + candidate) is not None:
                    sketch_id = candidate
                    break
        if sketch_id is None:
            raise ValueError(
                f"Cannot find parent sketch for surface query: {sketch_ref!r}"
            )
        pt_raw = global_repo.elements.get("_pt_" + sketch_id)
        if pt_raw is None:
            raise ValueError(f"Sketch plane not found for: {sketch_id!r}")
        surface_pt: dict = pt_raw
        topo = global_repo.elements.get("_topo_" + sketch_id, {})
        all_surfaces = topo.get("surfaces", []) if topo else []

        # Filter to the single surface whose ancestry matches the query.
        matched = [
            s for s in all_surfaces
            if s.get("query", "").startswith("?")
            and frozenset(_parse_ancestry(s["query"])[0]) == target_set
        ]
        loops = _extract_profile_loops(matched or all_surfaces, surface_pt)
        return loops, surface_pt

    raise ValueError(f"Cannot resolve profile from: {sketch_ref!r}")


def _resolve_direction(
    normal: list, pt: dict, direction: str, distance: float
) -> tuple[list, float, dict]:
    """Resolve direction mode to direction_vec, effective_distance, and effective_plane."""
    if direction == "reverse":
        direction_vec = [-n for n in normal]
        return direction_vec, distance, pt
    elif direction == "symmetric":
        direction_vec = list(normal)
        shift = [-n * distance / 2 for n in normal]
        shifted_origin = [
            pt["origin"][0] + shift[0],
            pt["origin"][1] + shift[1],
            pt["origin"][2] + shift[2],
        ]
        effective_plane = {
            "origin": shifted_origin,
            "x_axis": pt["x_axis"],
            "y_axis": pt["y_axis"],
            "normal": pt["normal"],
        }
        return direction_vec, distance, effective_plane
    else:
        return list(normal), distance, pt


def _collect_extrude_loops(
    sketch_ref: str,
    feature_id: str,
    feature: dict,
    distance: float,
    global_repo: Repository,
    body_store: dict,
) -> tuple[list, dict, str]:
    """Resolve one sketch reference to (loops, pt, sketch_id)."""
    pt: dict
    if sketch_ref.startswith("?") or sketch_ref.startswith("@"):
        loops, pt = _resolve_face_profile(sketch_ref, global_repo, body_store)
        return loops, pt, ""
    sketch_id = sketch_ref.lstrip("$")
    pt_raw = global_repo.elements.get("_pt_" + sketch_id)
    if pt_raw is None:
        raise ValueError(f"sketch not found: {sketch_id!r}")
    pt = pt_raw
    topo = global_repo.elements.get("_topo_" + sketch_id, {})
    surfaces = topo.get("surfaces", []) if topo else []
    _register_top_face(global_repo, feature_id, pt, surfaces, distance)
    return _extract_profile_loops(surfaces, pt), pt, sketch_id


def _split_compound(shape) -> list:
    """Return individual solids from a compound, or a single-element list."""
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS
    from cadquery.occ_impl.shapes import Shape as CQShape

    explorer = TopExp_Explorer(shape.wrapped, TopAbs_SOLID)
    solids = []
    while explorer.More():
        solids.append(CQShape.cast(TopoDS.Solid_s(explorer.Current())))
        explorer.Next()
    return solids if len(solids) > 1 else [shape]


def _solve_extrude(feature: dict, global_repo: Repository, body_store: dict) -> dict:
    """Extrude solver with OCC-backed geometry that writes to body_store."""
    from oversolved.types3d import Body

    try:
        feature_id = feature.get("id", "")
        # Support both flat format and the nested {"extrude": {...}} format written by the UI.
        sub = feature.get("extrude") or {}
        feature = {**sub, **feature}
        sketch_raw = feature.get("sketch", "")
        # Normalize sketch to a list of refs.
        if isinstance(sketch_raw, list):
            sketch_refs: list[str] = [s for s in sketch_raw if s]
        else:
            sketch_refs = [sketch_raw] if sketch_raw else []
        distance = float(feature.get("distance") or feature.get("depth") or 1.0)

        if distance == 0:
            raise ValueError("extrude distance must be non-zero")

        if not sketch_refs:
            raise ValueError("extrude requires at least one profile reference")

        all_loops: list = []
        first_pt: dict = {}
        first_sketch_id = ""
        for sketch_ref in sketch_refs:
            loops, pt, sketch_id = _collect_extrude_loops(
                sketch_ref, feature_id, feature, distance, global_repo, body_store
            )
            all_loops.extend(loops)
            if not first_pt:
                first_pt = pt
                first_sketch_id = sketch_id

        normal = first_pt.get("normal", [0, 0, 1])
        body_id = "body_" + feature_id
        result: dict = {"status": "ok", "body_id": body_id}

        operation = feature.get("operation", "add")

        try:
            from oversolved.geometry import extrude_profile as _ep

            if not all_loops:
                result["mesh_warning"] = "no closed profile found; body has no shape"
            else:
                direction = feature.get("direction", "normal")
                direction_vec, effective_distance, effective_plane = _resolve_direction(
                    normal, first_pt, direction, distance
                )
                tool_shape = _ep(
                    all_loops, effective_plane, direction_vec, effective_distance
                )

                if operation == "cut":
                    from oversolved.geometry import boolean_cut
                    cut_body_id = None
                    for existing_body in body_store.values():
                        if existing_body.shape is not None:
                            existing_body.shape = boolean_cut(existing_body.shape, tool_shape)
                            existing_body.modified_by.append(feature_id)
                            if cut_body_id is None:
                                cut_body_id = existing_body.id
                    # Return the body that was cut (if any)
                    if cut_body_id is not None:
                        result["body_id"] = cut_body_id
                    result["operation"] = "cut"
                elif operation == "new":
                    solids = _split_compound(tool_shape)
                    body_ids = []
                    for i, solid in enumerate(solids):
                        bid = body_id if i == 0 else f"{body_id}_{i}"
                        b = Body(id=bid, created_by=feature_id, shape=solid,
                                 sketch_id=first_sketch_id)
                        body_store[bid] = b
                        body_ids.append(bid)
                    result["body_id"] = body_ids[0]
                    result["body_ids"] = body_ids
                    result["operation"] = "new"
                else:
                    from oversolved.geometry import boolean_union
                    fused = False
                    fused_body_id = None
                    for existing_body in body_store.values():
                        if existing_body.shape is not None:
                            existing_body.shape = boolean_union(existing_body.shape, tool_shape)
                            existing_body.modified_by.append(feature_id)
                            fused = True
                            fused_body_id = existing_body.id
                            break
                    if fused:
                        # When fusing with existing body, return the existing body's ID
                        # so the frontend can find the mesh
                        result["body_id"] = fused_body_id
                        result["body_ids"] = [fused_body_id]
                        result["operation"] = "add"
                    else:
                        solids = _split_compound(tool_shape)
                        body_ids = []
                        for i, solid in enumerate(solids):
                            bid = body_id if i == 0 else f"{body_id}_{i}"
                            b = Body(id=bid, created_by=feature_id, shape=solid,
                                     sketch_id=first_sketch_id)
                            body_store[bid] = b
                            body_ids.append(bid)
                        result["body_id"] = body_ids[0]
                        result["body_ids"] = body_ids
                        result["operation"] = "add"
        except Exception as exc:
            result["mesh_warning"] = str(exc)

        return result
    except Exception as exc:
        return {"status": "exception", "exception": str(exc)}


def _solve_revolve(feature: dict, global_repo: Repository, body_store: dict) -> dict:
    """Revolve solver with OCC-backed geometry that writes to body_store."""
    from oversolved.types3d import Body

    try:
        feature_id = feature.get("id", "")
        # Support both flat format and the nested {"revolve": {...}} format written by the UI.
        sub = feature.get("revolve") or {}
        feature = {**sub, **feature}
        sketch_raw = feature.get("sketch", "")
        # Normalize sketch to a list of refs.
        if isinstance(sketch_raw, list):
            sketch_refs: list[str] = [s for s in sketch_raw if s]
        else:
            sketch_refs = [sketch_raw] if sketch_raw else []
        angle = float(feature.get("angle") or 360.0)

        if angle == 0:
            raise ValueError("revolve angle must be non-zero")

        if not sketch_refs:
            raise ValueError("revolve requires at least one profile reference")

        all_loops: list = []
        first_pt: dict = {}
        first_sketch_id = ""
        for sketch_ref in sketch_refs:
            loops, pt, sketch_id = _collect_extrude_loops(
                sketch_ref, feature_id, feature, 0.0, global_repo, body_store
            )
            all_loops.extend(loops)
            if not first_pt:
                first_pt = pt
                first_sketch_id = sketch_id

        axis_origin = feature.get("axis_origin", [0, 0, 0])
        axis_direction = feature.get("axis_direction", [0, 0, 1])
        axis_query = feature.get("axis")
        if axis_query:
            axis_data = global_repo.query(axis_query, body_store=body_store)
            if axis_data and "start" in axis_data and "end" in axis_data:
                start = axis_data["start"]
                end = axis_data["end"]
                axis_origin = list(start)
                dx = end[0] - start[0]
                dy = end[1] - start[1]
                dz = end[2] - start[2]
                length = math.sqrt(dx * dx + dy * dy + dz * dz)
                if length > 1e-12:
                    axis_direction = [dx / length, dy / length, dz / length]
        body_id = "body_" + feature_id
        result: dict = {"status": "ok", "body_id": body_id}

        operation = feature.get("operation", "add")
        body = Body(id=body_id, created_by=feature_id, shape=None, sketch_id=first_sketch_id)

        try:
            from oversolved.geometry import sketch_loops_to_face, revolve_face as _rf

            if not all_loops:
                result["mesh_warning"] = "no closed profile found; body has no shape"
            else:
                face = sketch_loops_to_face(all_loops, first_pt)
                tool_shape = _rf(face, axis_origin, axis_direction, angle)

                if operation == "cut":
                    from oversolved.geometry import boolean_cut
                    cut_body_id = None
                    for existing_body in body_store.values():
                        if existing_body.shape is not None:
                            existing_body.shape = boolean_cut(existing_body.shape, tool_shape)
                            existing_body.modified_by.append(feature_id)
                            if cut_body_id is None:
                                cut_body_id = existing_body.id
                    if cut_body_id is not None:
                        result["body_id"] = cut_body_id
                    result["operation"] = "cut"
                elif operation == "new":
                    body.shape = tool_shape
                    body_store[body_id] = body
                    result["operation"] = "new"
                else:
                    from oversolved.geometry import boolean_union
                    fused = False
                    fused_body_id = None
                    for existing_body in body_store.values():
                        if existing_body.shape is not None:
                            existing_body.shape = boolean_union(existing_body.shape, tool_shape)
                            existing_body.modified_by.append(feature_id)
                            fused = True
                            fused_body_id = existing_body.id
                            break
                    if fused:
                        result["body_id"] = fused_body_id
                        result["operation"] = "add"
                    else:
                        body.shape = tool_shape
                        body_store[body_id] = body
                        result["operation"] = "add"
        except Exception as exc:
            result["mesh_warning"] = str(exc)

        return result
    except Exception as exc:
        return {"status": "exception", "exception": str(exc)}


def _resolve_direction_query(query: str, global_repo: Repository, fallback: list[float], body_store: dict | None = None) -> list[float]:
    """Resolve a direction from a query string or return fallback.

    Query should reference a sketch line (@sketch_id/line_id) whose start/end
    are registered as 3D world coords in global_repo.
    """
    if not query:
        return fallback
    data = global_repo.query(query, body_store=body_store)
    if data and "start" in data and "end" in data:
        start = data["start"]
        end = data["end"]
        d = [end[k] - start[k] for k in range(3)]
        length = math.sqrt(sum(v * v for v in d))
        if length > 1e-12:
            return [v / length for v in d]
    return fallback


def _resolve_axis_query(
    query: str,
    global_repo: Repository,
    fallback_origin: list[float],
    fallback_direction: list[float],
    body_store: dict | None = None,
) -> tuple[list[float], list[float]]:
    """Resolve axis origin and direction from a query or return fallbacks."""
    if not query:
        return fallback_origin, fallback_direction
    data = global_repo.query(query, body_store=body_store)
    if data and "start" in data and "end" in data:
        start = data["start"]
        end = data["end"]
        axis_origin = list(start)
        d = [end[k] - start[k] for k in range(3)]
        length = math.sqrt(sum(v * v for v in d))
        if length > 1e-12:
            return axis_origin, [v / length for v in d]
    return fallback_origin, fallback_direction


def _build_array_transforms(
    feature: dict,
    global_repo: Repository,
) -> list[Any]:
    """Build list of gp_Trsf objects for array instances."""
    from oversolved.geometry import make_translation_trsf, make_rotation_trsf

    mode = feature.get("mode", "linear")
    trsfs: list[Any] = []

    if mode == "linear":
        count_x = int(feature.get("count_x", 2))
        pitch_x = float(feature.get("pitch_x", 10.0))
        dir_x = _resolve_direction_query(
            feature.get("direction_x_query", ""),
            global_repo,
            feature.get("direction_x", [1, 0, 0]),
        )
        for i in range(count_x):
            trsf = make_translation_trsf(dir_x[0] * pitch_x * i, dir_x[1] * pitch_x * i, dir_x[2] * pitch_x * i)
            trsfs.append(trsf)

    elif mode == "rectangular":
        count_x = int(feature.get("count_x", 2))
        count_y = int(feature.get("count_y", 2))
        pitch_x = float(feature.get("pitch_x", 10.0))
        pitch_y = float(feature.get("pitch_y", 10.0))
        dir_x = _resolve_direction_query(
            feature.get("direction_x_query", ""),
            global_repo,
            feature.get("direction_x", [1, 0, 0]),
        )
        dir_y = _resolve_direction_query(
            feature.get("direction_y_query", ""),
            global_repo,
            feature.get("direction_y", [0, 1, 0]),
        )
        for j in range(count_y):
            for i in range(count_x):
                trsf = make_translation_trsf(
                    dir_x[0] * pitch_x * i + dir_y[0] * pitch_y * j,
                    dir_x[1] * pitch_x * i + dir_y[1] * pitch_y * j,
                    dir_x[2] * pitch_x * i + dir_y[2] * pitch_y * j,
                )
                trsfs.append(trsf)

    elif mode == "rotational":
        count = int(feature.get("count", 4))
        step_angle_raw = feature.get("step_angle")
        if step_angle_raw is None:
            step = 360.0 / count
        else:
            step = float(step_angle_raw)
        axis_origin = feature.get("axis_origin", [0, 0, 0])
        axis_direction = feature.get("axis_direction", [0, 0, 1])
        axis_origin, axis_direction = _resolve_axis_query(
            feature.get("axis", ""),
            global_repo,
            axis_origin,
            axis_direction,
        )
        for i in range(count):
            trsf = make_rotation_trsf(axis_origin, axis_direction, math.radians(step * i))
            trsfs.append(trsf)

    return trsfs


def _solve_array(
    feature: dict,
    global_repo: Repository,
    body_store: dict,
) -> dict:
    """Solve an array feature: replicate a body using linear/rectangular/rotational transforms."""
    from oversolved.types3d import Body
    from oversolved.geometry import transform_copy, fuse_shapes

    try:
        feature_id = feature.get("id", "")
        sub = feature.get("array") or {}
        feature = {**sub, **feature}

        source_body_id = "body_" + feature.get("source_body", "")
        body = body_store.get(source_body_id)
        if body is None or body.shape is None:
            body = list(body_store.values())[0] if body_store else None
            if body is None or body.shape is None:
                raise ValueError("array: no source body with shape found")
            source_body_id = body.id

        include_source = bool(feature.get("include_source", True))
        operation = feature.get("operation", "add")

        trsfs = _build_array_transforms(feature, global_repo)

        instances: list = []
        for i, trsf in enumerate(trsfs):
            if i == 0 and include_source:
                instances.append(body.shape)
            else:
                instances.append(transform_copy(body.shape, trsf))

        if not instances:
            raise ValueError("array produced no instances")

        tool_shape = fuse_shapes(instances)

        result_body_id = "body_" + feature_id
        if operation == "new":
            new_body = Body(
                id=result_body_id,
                created_by=feature_id,
                shape=tool_shape,
                sketch_id="",
            )
            body_store[result_body_id] = new_body
            return {"status": "ok", "body_id": result_body_id, "operation": "new"}
        else:
            body.shape = tool_shape
            body.modified_by.append(feature_id)
            return {"status": "ok", "body_id": source_body_id, "operation": "add"}

    except Exception as exc:
        return {"status": "exception", "exception": str(exc)}


def _solve_import_step(
    feature: dict,
    global_repo: Repository,
    body_store: dict,
) -> dict:
    """Import a STEP file as a body."""
    try:
        from oversolved.types3d import Body

        feature_id = feature.get("id", "")
        file_id = feature.get("file_id", "")
        if not file_id:
            raise ValueError("import_step requires 'file_id'")

        if os.sep in file_id or "/" in file_id or ".." in file_id:
            raise ValueError(f"invalid file_id: {file_id!r}")

        upload_dir = os.path.join(os.path.dirname(__file__), "uploads")
        filepath = os.path.join(upload_dir, file_id)
        if not os.path.isfile(filepath):
            raise ValueError(f"file not found: {file_id!r}")

        scale = float(feature.get("scale", 1.0))
        body_id = "body_" + feature_id

        from oversolved.geometry import step_file_to_shape

        shape = step_file_to_shape(filepath, scale=scale)
        body_store[body_id] = Body(
            id=body_id,
            created_by=feature_id,
            shape=shape,
        )
        return {"status": "ok", "body_id": body_id}
    except Exception as exc:
        raise ValueError(str(exc)) from exc


def _resolve_fillet_edges(body, edge_queries):
    """Resolve edge query strings to TopoDS_Edge objects from a body shape."""
    from oversolved.query import make_ancestry_query, _parse_ancestry
    import re

    if body.shape is None or not edge_queries:
        return []

    seen_hashes = set()
    topo_edges = []
    edge_types = []
    for edge in body.shape.edges():
        h = edge.hashCode()
        if h in seen_hashes:
            continue
        seen_hashes.add(h)
        topo_edges.append(edge.wrapped)
        gt = edge.geomType()
        edge_types.append("straightedge" if gt == "LINE" else "edge")

    query_to_edge = {}
    for idx, (te, et) in enumerate(zip(topo_edges, edge_types)):
        if body.created_by:
            aq = make_ancestry_query(
                [f"@{body.created_by}edge{idx}", f"@{body.created_by}"],
                et
            )
            query_to_edge[aq] = te
        query_to_edge[f"?{body.id}:edge:{idx}"] = te

    result = []
    for q in edge_queries:
        edge = query_to_edge.get(q)
        if edge is None and q.startswith("?"):
            try:
                ids, _ = _parse_ancestry(q)
                for id_str in ids:
                    m = re.match(r"@(\w+)edge(\d+)$", id_str)
                    if m:
                        eidx = int(m.group(2))
                        if 0 <= eidx < len(topo_edges):
                            edge = topo_edges[eidx]
                            break
            except Exception:
                pass
        if edge is not None:
            result.append(edge)

    return result


def _solve_transform(
    feature: dict,
    global_repo: Repository,
    body_store: dict,
) -> dict:
    """Apply translation, rotation, and/or uniform scaling to an existing body."""
    from oversolved.cadquery_ops import apply_transform_shape
    from oversolved.types3d import Body

    try:
        feature_id = feature.get("id", "")
        sub = feature.get("transform") or {}
        cfg = {**sub, **{k: v for k, v in feature.items() if k not in ("transform",)}}

        body_query = cfg.get("body", "")
        source_body = _resolve_body(body_query, body_store) if body_query else None
        if source_body is None or source_body.shape is None:
            raise ValueError(f"transform: body not found: {body_query!r}")

        translation = cfg.get("translation")
        tr_from = cfg.get("translation_from")
        tr_to = cfg.get("translation_to")
        if tr_from and tr_to:
            p0_ref = global_repo.query(tr_from, body_store=body_store)
            p1_ref = global_repo.query(tr_to, body_store=body_store)
            if p0_ref is None:
                raise ValueError(f"transform: translation_from not found: {tr_from!r}")
            if p1_ref is None:
                raise ValueError(f"transform: translation_to not found: {tr_to!r}")
            p0 = _get_point_3d(p0_ref, global_repo)
            p1 = _get_point_3d(p1_ref, global_repo)
            translation = [float(p1[i] - p0[i]) for i in range(3)]

        rotation_angle = float(cfg.get("rotation_angle", 0.0))
        rotation_axis_origin = cfg.get("rotation_axis_origin")
        rotation_axis_direction = cfg.get("rotation_axis_direction")
        axis_query = cfg.get("rotation_axis")
        if axis_query:
            edge_ref = global_repo.query(axis_query, body_store=body_store)
            if edge_ref is None:
                raise ValueError(f"transform: rotation_axis not found: {axis_query!r}")
            edge = _get_edge_3d(edge_ref, global_repo)
            if edge:
                p0, p1 = edge
                d = [float(p1[i] - p0[i]) for i in range(3)]
                length = sum(x * x for x in d) ** 0.5
                if length > 1e-10:
                    rotation_axis_origin = list(p0)
                    rotation_axis_direction = [x / length for x in d]

        scale = float(cfg.get("scale", 1.0))
        scale_center = cfg.get("scale_center")
        scale_center_query = cfg.get("scale_center_from")
        if scale_center_query:
            pt_ref = global_repo.query(scale_center_query, body_store=body_store)
            if pt_ref is None:
                raise ValueError(f"transform: scale_center_from not found: {scale_center_query!r}")
            scale_center = list(_get_point_3d(pt_ref, global_repo))

        new_shape = apply_transform_shape(
            source_body.shape,
            translation=translation,
            rotation_axis_origin=rotation_axis_origin,
            rotation_axis_direction=rotation_axis_direction,
            rotation_angle_deg=rotation_angle,
            scale=scale,
            scale_center=scale_center,
        )

        operation = cfg.get("operation", "new")
        if operation == "replace":
            source_body.shape = new_shape
            source_body.modified_by = list(source_body.modified_by or []) + [feature_id]
            return {"status": "ok", "body_id": source_body.id, "operation": "replace"}
        else:
            new_body_id = "body_" + feature_id
            body_store[new_body_id] = Body(
                id=new_body_id,
                created_by=feature_id,
                modified_by=[],
                shape=new_shape,
                sketch_id=source_body.sketch_id,
            )
            return {"status": "ok", "body_id": new_body_id, "operation": "new"}
    except Exception as exc:
        return {"status": "exception", "exception": str(exc)}


def _solve_fillet(
    feature: dict,
    global_repo: Repository,
    body_store: dict,
) -> dict:
    """Apply fillet to edges of an existing body."""
    from oversolved.geometry import apply_fillet

    try:
        feature_id = feature.get("id", "")
        sub = feature.get("fillet") or {}
        feature = {**sub, **feature}

        edges: list[str] = feature.get("edges", [])
        radius_raw = feature.get("radius")
        radius = float(radius_raw if radius_raw is not None else 1.0)

        if not edges:
            raise ValueError("fillet requires at least one edge")

        if radius <= 0:
            raise ValueError("fillet radius must be positive")

        body_id = "body_" + feature.get("source_body", "")
        if body_id not in body_store:
            body = list(body_store.values())[0] if body_store else None
            if body is None:
                raise ValueError("no body found for fillet")
            body_id = body.id
            body = body_store[body_id]
        else:
            body = body_store[body_id]

        if body.shape is None:
            raise ValueError(f"body {body_id} has no shape")

        topo_edges = _resolve_fillet_edges(body, edges)
        if not topo_edges:
            raise ValueError("no edges resolved for fillet")

        new_shape = apply_fillet(body.shape, radius, edges=topo_edges)
        body.shape = new_shape
        body.modified_by.append(feature_id)

        return {"status": "ok", "body_id": body_id}
    except Exception as exc:
        return {"status": "exception", "exception": str(exc)}


def _solve_chamfer(
    feature: dict,
    global_repo: Repository,
    body_store: dict,
) -> dict:
    """Apply chamfer to edges of an existing body."""
    from oversolved.geometry import apply_chamfer

    try:
        feature_id = feature.get("id", "")
        sub = feature.get("chamfer") or {}
        feature = {**sub, **feature}

        edges: list[str] = feature.get("edges", [])
        distance_raw = feature.get("distance")
        distance = float(distance_raw if distance_raw is not None else 1.0)
        kind = feature.get("kind", "distance")
        angle_raw = feature.get("angle")
        angle = float(angle_raw if angle_raw is not None else 45.0)

        if not edges:
            raise ValueError("chamfer requires at least one edge")

        if distance <= 0:
            raise ValueError("chamfer distance must be positive")

        body_id = "body_" + feature.get("source_body", "")
        if body_id not in body_store:
            body = list(body_store.values())[0] if body_store else None
            if body is None:
                raise ValueError("no body found for chamfer")
            body_id = body.id
            body = body_store[body_id]
        else:
            body = body_store[body_id]

        if body.shape is None:
            raise ValueError(f"body {body_id} has no shape")

        topo_edges = _resolve_fillet_edges(body, edges)
        if not topo_edges:
            raise ValueError("no edges resolved for chamfer")

        new_shape = apply_chamfer(body.shape, distance, kind=kind, angle=angle, edges=topo_edges)
        body.shape = new_shape
        body.modified_by.append(feature_id)

        return {"status": "ok", "body_id": body_id}
    except Exception as exc:
        return {"status": "exception", "exception": str(exc)}


def _resolve_body(ref: str, body_store: dict):
    """Resolve @body_<id> or @<featureId> to a Body from body_store."""
    from oversolved.types3d import Body  # noqa: PLC0415, F401

    key = ref.lstrip("@")
    if key in body_store:
        return body_store[key]
    prefixed = "body_" + key
    if prefixed in body_store:
        return body_store[prefixed]
    for body in body_store.values():
        if body.created_by == key:
            return body
    raise ValueError(f"boolean: body not found for ref '{ref}'")


def _solve_boolean(
    feature: dict,
    global_repo: Repository,
    body_store: dict,
) -> dict:
    """Apply boolean operation between bodies."""
    from oversolved.cadquery_ops import boolean_cut, boolean_union, boolean_intersection

    try:
        feature_id = feature.get("id", "")
        sub = feature.get("boolean") or {}
        operation = sub.get("operation", "union")
        target_ref = sub.get("target", "")
        tool_refs = sub.get("tools") or []
        keep_tools = sub.get("keep_tools", False)

        if not target_ref:
            raise ValueError("boolean: 'target' is required")
        if not tool_refs:
            raise ValueError("boolean: 'tools' must have at least one entry")

        target_body = _resolve_body(target_ref, body_store)

        result_shape = target_body.shape
        consumed_keys: list[str] = []

        for tool_ref in tool_refs:
            tool_body = _resolve_body(tool_ref, body_store)
            if operation == "union":
                result_shape = boolean_union(result_shape, tool_body.shape)
            elif operation == "subtract":
                result_shape = boolean_cut(result_shape, tool_body.shape)
            elif operation == "intersect":
                result_shape = boolean_intersection(result_shape, tool_body.shape)
            else:
                raise ValueError(f"boolean: unknown operation '{operation}'")
            if not keep_tools:
                consumed_keys.append(tool_body.id)

        target_body.shape = result_shape
        target_body.modified_by.append(feature_id)

        for key in consumed_keys:
            body_store.pop(key, None)

        return {"status": "ok", "body_id": target_body.id, "operation": operation}
    except Exception as exc:
        return {"status": "exception", "exception": str(exc)}


def _solve_delete_body(feature: dict, global_repo: Repository, body_store: dict) -> dict:
    try:
        sub = feature.get("delete_body") or {}
        body_query = sub.get("body", "")
        if body_query.startswith("?"):
            resolved = global_repo.query(body_query, body_store=body_store)
            if resolved is None:
                raise ValueError(f"delete_body: body not found: {body_query!r}")
            if hasattr(resolved, 'id'):
                body_key = resolved.id
            elif isinstance(resolved, dict) and resolved.get("body_id"):
                body_key = resolved["body_id"]
            else:
                raise ValueError(f"delete_body: query did not resolve to a body: {body_query!r}")
        else:
            body_key = body_query.lstrip("@")
            if body_key not in body_store:
                prefixed = "body_" + body_key
                if prefixed in body_store:
                    body_key = prefixed
                else:
                    raise ValueError(f"delete_body: body not found: {body_query!r}")
        del body_store[body_key]
        return {"status": "ok", "deleted_body_id": body_key}
    except Exception as exc:
        return {"status": "exception", "exception": str(exc)}


def _solve_hole(feature: dict, global_repo: Repository, body_store: dict, features_by_id: dict[str, dict]) -> dict:
    try:
        import numpy as np
        from oversolved.cadquery_ops import make_cylinder, boolean_cut

        sub = feature.get("hole") or {}
        sketch_ref = sub.get("sketch", "").lstrip("@")
        diameter = float(sub.get("diameter", 10.0))
        depth_mode = sub.get("depth_mode", "blind")
        depth = float(sub.get("depth", 10.0))
        direction = sub.get("direction", "normal")
        target_ref = sub.get("target", "")

        radius = diameter / 2.0

        plane = global_repo.elements.get("_pt_" + sketch_ref)
        if plane is None:
            raise ValueError(f"hole: sketch '{sketch_ref}' has no plane transform registered")

        origin = np.array(plane["origin"])
        x_axis = np.array(plane["x_axis"])
        y_axis = np.array(plane["y_axis"])
        normal = np.array(plane["normal"])
        axis = normal if direction == "normal" else -normal

        if target_ref:
            key = target_ref.lstrip("@")
            target_body = body_store.get(key) or body_store.get("body_" + key)
            if target_body is None:
                raise ValueError(f"hole: target body '{target_ref}' not found")
        else:
            if not body_store:
                raise ValueError("hole: no bodies in body_store and no target specified")
            target_body = next(iter(body_store.values()))

        sketch_feature = features_by_id.get(sketch_ref, {})
        entities = sketch_feature.get("entities", [])
        point_entities = [e for e in entities if e.get("kind") == "point"]

        if not point_entities:
            raise ValueError(f"hole: sketch '{sketch_ref}' has no point entities")

        if depth_mode == "through_all":
            bb = target_body.shape.BoundingBox()
            span = max(bb.xmax - bb.xmin, bb.ymax - bb.ymin, bb.zmax - bb.zmin)
            through_depth = span * 3.0
            through_back_offset = span
        else:
            through_depth = None
            through_back_offset = 0.0

        for entity in point_entities:
            eid = entity["id"]
            xy_entry = global_repo.elements.get(sketch_ref + "/" + eid + "/xy")
            if xy_entry is None:
                continue
            x2d, y2d = xy_entry["external_xy"]
            center_3d = origin + x2d * x_axis + y2d * y_axis

            if depth_mode == "through_all":
                start_3d = center_3d - axis * through_back_offset
                h = through_depth
            else:
                start_3d = center_3d
                h = depth

            cyl = make_cylinder(list(start_3d), list(axis), radius, h)
            target_body.shape = boolean_cut(target_body.shape, cyl)

        target_body.modified_by.append(feature["id"])
        return {
            "status": "ok",
            "body_id": target_body.id,
            "hole_count": len(point_entities),
        }
    except Exception as exc:
        return {"status": "exception", "exception": str(exc)}


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
                {"id": eid + "_top", "kind": "line"},
                {"id": eid + "_right", "kind": "line"},
                {"id": eid + "_bottom", "kind": "line"},
                {"id": eid + "_left", "kind": "line"},
            ]
            expanded.extend(tops)
            initial.setdefault(eid + "_top", [cx - hw, cy + hh, cx + hw, cy + hh])
            initial.setdefault(eid + "_right", [cx + hw, cy + hh, cx + hw, cy - hh])
            initial.setdefault(eid + "_bottom", [cx + hw, cy - hh, cx - hw, cy - hh])
            initial.setdefault(eid + "_left", [cx - hw, cy - hh, cx - hw, cy + hh])
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
                    proj_params = _project_source_to_params(
                        kind, source_query, target_plane, global_repo
                    )
                    initial[eid] = proj_params
                    constraints.append(
                        {
                            "id": f"__proj_{eid}__",
                            "kind": "fixed",
                            "target": {"entity": eid},
                        }
                    )
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
    repo.register("builtin_origin", {"entity": ORIGIN_ID, "point": "xy"})
    repo.register(
        "builtin_plane_front",
        {
            "type": "plane",
            "origin": [0, 0, 0],
            "x_axis": [1, 0, 0],
            "y_axis": [0, 1, 0],
            "normal": [0, 0, 1],
        },
    )
    repo.register(
        "builtin_plane_top",
        {
            "type": "plane",
            "origin": [0, 0, 0],
            "x_axis": [1, 0, 0],
            "y_axis": [0, 0, -1],
            "normal": [0, 1, 0],
        },
    )
    repo.register(
        "builtin_plane_right",
        {
            "type": "plane",
            "origin": [0, 0, 0],
            "x_axis": [0, 0, -1],
            "y_axis": [0, 1, 0],
            "normal": [1, 0, 0],
        },
    )

    for eid, entity in entities.items():
        kind = entity["kind"]
        repo.register(feature_id + eid, {"entity": eid})
        if kind == "line":
            repo.register(feature_id + eid + "start", {"entity": eid, "point": "start"})
            repo.register(feature_id + eid + "end", {"entity": eid, "point": "end"})
        elif kind == "circle":
            repo.register(
                feature_id + eid + "center", {"entity": eid, "point": "center"}
            )
        elif kind == "arc":
            repo.register(feature_id + eid + "start", {"entity": eid, "point": "start"})
            repo.register(feature_id + eid + "end", {"entity": eid, "point": "end"})
            repo.register(
                feature_id + eid + "center", {"entity": eid, "point": "center"}
            )
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
        if (
            (plane_obj is None or not is_plane_type(plane_obj))
            and plane_query.startswith("$")
            and global_repo is not None
        ):
            plane_obj = global_repo.elements.get(plane_query[1:])
        if plane_obj is None or not is_plane_type(plane_obj):
            _bare = {
                "Top": "builtin_plane_top",
                "Front": "builtin_plane_front",
                "Right": "builtin_plane_right",
            }
            plane_obj = _BUILTIN_PLANES.get(_bare.get(plane_query, ""), _FRONT_PLANE)
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
            elif isinstance(ref, dict) and ref.get("type") in _FACE_TYPES:
                pass  # topology face — projected to external_xy during pre-resolve
            else:
                # ref is None or resolved to an unexpected dict format — invalid
                ids.append(None)
        return ids

    constraints = [
        c
        for c in constraints
        if all(eid in entities for eid in _constraint_entity_ids(c))
    ]

    # Pre-resolve all query strings to {entity, point?} dicts so the rest of
    # the solver (residuals, render) can use them without any further changes.
    unresolved_refs = []  # Track failed reference resolutions for reporting

    def _pre_resolve(c: dict) -> dict:
        rc = dict(c)
        constraint_id = c.get("id", "(unknown)")
        constraint_kind = c.get("kind", "(unknown)")
        for field in _REF_FIELDS:
            if field in rc and isinstance(rc[field], str):
                ref = rc[field]
                resolved = resolve_ref(ref)
                if resolved is not None:
                    # Topology face: project world-space origin onto sketch 2D coords.
                    if isinstance(resolved, dict) and resolved.get("type") in _FACE_TYPES:
                        face_origin = resolved.get("origin", [0, 0, 0])
                        sk_origin = plane_obj.get("origin", [0, 0, 0])
                        x_axis = plane_obj.get("x_axis", [1, 0, 0])
                        y_axis = plane_obj.get("y_axis", [0, 1, 0])
                        dp = [face_origin[i] - sk_origin[i] for i in range(3)]
                        u = sum(dp[i] * x_axis[i] for i in range(3))
                        v = sum(dp[i] * y_axis[i] for i in range(3))
                        resolved = {"external_xy": [u, v]}
                    rc[field] = resolved
                else:
                    # Reference failed to resolve — track it for reporting
                    unresolved_refs.append(
                        {
                            "constraint_id": constraint_id,
                            "constraint_kind": constraint_kind,
                            "field": field,
                            "ref": ref,
                        }
                    )
        return rc

    constraints = [_pre_resolve(c) for c in constraints]

    # Filter out constraints that reference only external entities when the constraint
    # type requires a local entity (e.g., horizontal/vertical on a line needs a line entity).
    def _has_valid_local_target(c: dict) -> bool:
        """Check if constraint has at least one resolvable local entity when required."""
        kind = c.get("kind", "")
        # Constraint kinds that need a local entity for their target or primary ref
        needs_local_entity = {
            "horizontal",
            "vertical",
            "length",
            "radius",
            "diameter",
            "line_distance",
            "concentric",
            "equal_length",
            "tangent",
        }
        if kind not in needs_local_entity:
            return True  # Other constraint kinds don't require local entities
        # Check if constraint has a local entity reference
        if "target" in c and isinstance(c["target"], dict) and "entity" in c["target"]:
            return True
        if "a" in c and isinstance(c["a"], dict) and "entity" in c["a"]:
            return True
        if "b" in c and isinstance(c["b"], dict) and "entity" in c["b"]:
            return True
        if "line" in c and isinstance(c["line"], dict) and "entity" in c["line"]:
            return True
        if "arc" in c and isinstance(c["arc"], dict) and "entity" in c["arc"]:
            return True
        return False

    constraints = [c for c in constraints if _has_valid_local_target(c)]

    # Implicit constraint: pin the projected origin to (0, 0).
    # This is appended AFTER pre-resolution; it uses an already-resolved dict directly.
    constraints.append(
        {
            "id": ORIGIN_FIX_ID,
            "kind": "fixed",
            "target": {"entity": ORIGIN_ID, "point": "xy"},
            "x": 0.0,
            "y": 0.0,
        }
    )

    x0 = np.array(params, dtype=np.float64)

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
            if (
                _a_eid
                and _b_eid
                and entities.get(_a_eid, {}).get("kind") == "line"
                and entities.get(_b_eid, {}).get("kind") == "circle"
                and "point" not in _b
            ):
                _line_circle_coincident[(_a_eid, _b_eid)] = _a.get("point", "start")

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
                    # line-to-line collinear: both lines lie on the same infinite line
                    ea = get_params(x, a_eid)
                    eb = get_params(x, b_eid)
                    da = ea[2:4] - ea[0:2]
                    db = eb[2:4] - eb[0:2]
                    r.append(da[0] * db[1] - da[1] * db[0])  # parallel
                    n = np.sqrt(da[0] ** 2 + da[1] ** 2)
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
                elif (
                    not b_external
                    and "point" not in b_ref
                    and b_kind in ("circle", "arc")
                ):
                    # point on circle/arc: distance from center = radius
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
                    # Unnormalized: same zeros, avoids 1/|d| blowup for short lines
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
                        dist = np.sqrt(
                            (contact[0] - arc_ep[0]) ** 2
                            + (contact[1] - arc_ep[1]) ** 2
                        )
                        r.append(dist - arc_ep[2])
                else:
                    contact = line_ep[2:4]
                    radius_dir = _radius_dir(x, arc_ref["entity"], arc_ref, contact)
                    # perpendicularity: line direction dot radius direction == 0
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

    opt = least_squares(
        residuals,
        x0,
        method="trf",
        jac="3-point",
        ftol=1e-10,
        xtol=1e-10,
        gtol=1e-10,
        max_nfev=10000,
    )
    x_sol = opt.x
    # least_squares cost = 0.5 * sum(residuals**2)
    final_loss = 2.0 * float(opt.cost)

    # Constraint status via Jacobian rank
    J = (
        opt.jac
        if opt.jac is not None and opt.jac.shape[0] > 0
        else np.zeros((0, len(x_sol)))
    )
    rank = int(np.linalg.matrix_rank(J, tol=RANK_TOL))
    n_params = len(x_sol)

    # Each fixed constraint pins 2 rigid-body DOF (tx, ty). Reduce the 3-DOF
    # rigid-body allowance accordingly so genuinely free parameters are
    # flagged.
    n_fixed_pinned = sum(
        ENTITY_SIZES[entities[c["target"]["entity"]]["kind"]]
        if ("point" not in c.get("target", {}) and "x" not in c and "y" not in c)
        else 2
        for c in constraints
        if c["kind"] == "fixed"
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
    for vid, pt in topology["intersection_points"].items():
        geom_solved[vid] = {"x": pt["x"], "y": pt["y"], "intersection": True}

    # Per-entity status via null-space analysis.
    # The null space of J encodes all unconstrained directions. We project out
    # the 3 rigid-body modes (translation x/y, rotation) so that a freely
    # floating but shape-determined sketch doesn't flag its entities as free.
    entity_status = _entity_status(J, rank, entities, entity_offsets, n_params, status)

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
            if int(np.linalg.matrix_rank(J_remaining, tol=RANK_TOL)) == int(
                np.linalg.matrix_rank(J_active, tol=RANK_TOL)
            ):
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
    features = {
        eid: {"status": st}
        for eid, st in entity_status.items()
        if not entities.get(eid, {}).get("projected")
    }

    result = {
        "status": status,
        "geometry": geometry_flat,
        "projected": projected_flat,
        "features": features,
        "topology": topology,
        "constraints": constraints_out,
        "plane_transform": _plane_transform(plane_obj),
    }

    # Report any unresolved constraint references as warnings
    if unresolved_refs:
        result["warnings"] = [
            f"Constraint {r['constraint_id']} ({r['constraint_kind']}): "
            f"failed to resolve reference '{r['ref']}' in field '{r['field']}' "
            f"(constraint may be ineffective)"
            for r in unresolved_refs
        ]

    return result
