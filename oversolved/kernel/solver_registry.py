import logging
import math
from oversolved.kernel.query import Repository, _parse_ancestry, make_ancestry_query, _evict_ancestry_and_register, ref
from oversolved.kernel.profile_loops import match_area_reid, _surface_ancestor_key, _loop_centroid
from oversolved.kernel.types3d import Frame3D

__all__ = [
    "_clear_feature_geometry_registrations",
    "_post_register",
    "_enrich_geometry",
    "_register_solved_geometry_slash",
    "_plane_transform",
    "_register_topology_surfaces",
    "_register_topology_edges",
    "_register_topology_vertices",
    "_register_sketch_feature",
]

# ─── Ancestral registry lifecycle invariant ───
# Each registration path must deduplicate before appending to global_repo.ancestral.
# Without dedup, repeated solves accumulate entries for the same ancestry key, causing
# AmbiguousQueryError. Dedup: if an identical payload already exists under the key,
# skip; if a stale payload exists, evict all old entries first, then register fresh.
# All payloads targeted by _clear_feature_geometry_registrations must include a
# sketch_id field. The ancestral registry is append-only; dedup is the only defense
# against unbounded growth.

logger = logging.getLogger(__name__)


def _clear_feature_geometry_registrations(
    global_repo: Repository, feature_id: str
) -> None:
    """Remove all geometry registrations previously made for a feature.
    This prevents ghost references when entities are deleted and the
    feature is re-solved.

    Clears two classes of entries:
    1. Ancestry entries whose payload carries sketch_id == feature_id (entity params).
    2. All ancestry entries whose frozenset key contains the bare @feature_id tag.
       This covers topology surfaces, edges, and vertices registered by detect_topology.
    """
    feature_tag = ref(feature_id)
    eids_to_remove: set[str] = set()
    keys_to_remove: list[frozenset] = []

    for key, element_ids in list(global_repo.ancestral.items()):
        # Topology/surface/vertex entries: key contains the bare @feature_id tag.
        if feature_tag in key:
            keys_to_remove.append(key)
            eids_to_remove.update(element_ids)
            continue

        # Entity-param entries: payload carries sketch_id == feature_id.
        for eid in element_ids:
            payload = global_repo.elements.get(eid)
            if payload and isinstance(payload, dict) and payload.get("sketch_id") == feature_id:
                eids_to_remove.add(eid)
                keys_to_remove.append(key)
                break

    for eid in eids_to_remove:
        global_repo.elements.pop(eid, None)
    for key in keys_to_remove:
        global_repo.ancestral.pop(key, None)

    # Clear any remaining direct elements registered via register() with this sketch_id.
    global_repo.clear_by_sketch_id(feature_id)


def _apply_area_reid(
    global_repo: Repository,
    reid_map: dict[frozenset, list[frozenset]],
    new_surfaces: list[dict],
    plane_obj: "Frame3D | dict",
) -> None:
    """Register new surfaces under old ancestry keys produced by the re-id heuristic.

    For each old_key → [new_key, ...] entry in reid_map, look up the already-
    registered payload for each new_key and add it under old_key as well.  This
    lets downstream ancestry queries that reference entity IDs from the previous
    solve still resolve after a topology-changing edit (e.g. line replaced by arc).
    """
    # Build a lookup from new_key frozenset → registered payload.
    new_key_to_payload: dict[frozenset, dict] = {}
    for surface in new_surfaces:
        key = _surface_ancestor_key(surface)
        if not key:
            continue
        candidate_ids = global_repo.ancestral.get(key, [])
        if candidate_ids:
            payload = global_repo.elements.get(candidate_ids[0])
            if payload is not None:
                new_key_to_payload[key] = payload

    for old_key, new_keys in reid_map.items():
        # Skip if the old key is already live (no topology change happened).
        if old_key in global_repo.ancestral:
            continue
        for new_key in new_keys:
            payload = new_key_to_payload.get(new_key)
            if payload is None:
                continue
            existing = global_repo.ancestral.get(old_key, [])
            # Avoid double-registration of the same payload under this old key.
            if any(global_repo.elements.get(eid) == payload for eid in existing):
                continue
            global_repo.register_ancestor(list(old_key), payload)


def _post_register(
    global_repo: Repository,
    feature_id: str,
    feature: dict,
    feature_result: dict,
) -> None:
    """Register solved state from feature_result into global_repo for downstream use."""
    if feature_result.get("status") == "exception":
        return

    # Snapshot previous topology surfaces before clearing, so the area re-id
    # heuristic can map old surface ancestry keys to new ones.
    prev_topo = global_repo.elements.get("_topo_" + feature_id)
    prev_surfaces: list[dict] = prev_topo.get("surfaces", []) if isinstance(prev_topo, dict) else []

    _clear_feature_geometry_registrations(global_repo, feature_id)
    if "geometry" in feature_result:
        _register_solved_geometry_slash(
            global_repo, feature_id, feature, feature_result["geometry"]
        )

    if "plane_transform" in feature_result:
        pt = feature_result["plane_transform"]
        frame = Frame3D.from_plane_transform(pt)
        global_repo.register(
            "_pt_" + feature_id,
            frame.to_dict(),
        )
    if "topology" in feature_result:
        global_repo.register("_topo_" + feature_id, feature_result["topology"])
        pt = feature_result.get("plane_transform")
        if pt:
            frame = Frame3D.from_plane_transform(pt)
            plane_obj: Frame3D = Frame3D(
                origin=frame.origin,
                x_axis=frame.x_axis,
                y_axis=frame.y_axis,
                normal=frame.normal,
            )
            new_surfaces = feature_result["topology"].get("surfaces", [])
            _register_topology_surfaces(
                global_repo, feature_result["topology"], plane_obj
            )
            _register_topology_edges(global_repo, feature_result["topology"], plane_obj)
            _register_topology_vertices(
                global_repo, feature_result["topology"], plane_obj, feature_id
            )
            # Apply area re-id: register new surfaces also under old ancestry keys
            # so downstream area picks survive topology changes (line → arc, etc.).
            if prev_surfaces and new_surfaces:
                reid_map = match_area_reid(prev_surfaces, new_surfaces)
                _apply_area_reid(global_repo, reid_map, new_surfaces, plane_obj)
        _register_sketch_feature(global_repo, feature_id, feature_result)


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
        if kind in ("line", "projected_line"):
            global_repo.register(
                prefix + "/start",
                {"external_xy": list(params[0:2]), "sketch_id": feature_id},
            )
            global_repo.register(
                prefix + "/end",
                {"external_xy": list(params[2:4]), "sketch_id": feature_id},
            )
        elif kind in ("circle", "projected_circle"):
            global_repo.register(
                prefix + "/center",
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
        elif kind in ("point", "projected_point"):
            global_repo.register(
                prefix + "/xy",
                {"external_xy": list(params[0:2]), "sketch_id": feature_id},
            )


def _sketch_to_world_2d(xy: list[float], plane_obj: Frame3D | dict) -> list[float]:
    """Transform 2D sketch coordinates to 3D world space."""
    if isinstance(plane_obj, Frame3D):
        x_axis = plane_obj.x_axis
        y_axis = plane_obj.y_axis
        origin = plane_obj.origin
    else:
        x_axis = plane_obj["x_axis"]
        y_axis = plane_obj["y_axis"]
        origin = plane_obj["origin"]
    u, v = xy
    return [
        origin[0] + u * x_axis[0] + v * y_axis[0],
        origin[1] + u * x_axis[1] + v * y_axis[1],
        origin[2] + u * x_axis[2] + v * y_axis[2],
    ]


def _plane_transform(plane_obj: Frame3D | dict) -> dict:
    """Convert a Frame3D or plane dict to a plane_transform dict."""
    if isinstance(plane_obj, Frame3D):
        return plane_obj.to_plane_transform()
    x_axis = plane_obj.get("x_axis", [1, 0, 0])
    y_axis = plane_obj.get("y_axis", [0, 1, 0])
    normal = plane_obj.get("normal", [0, 0, 1])
    origin = plane_obj.get("origin", [0, 0, 0])
    return {
        "rotation": list(x_axis) + list(y_axis) + list(normal),
        "origin": list(origin),
    }


def _register_topology_surfaces(
    global_repo: Repository, topology: dict, plane_obj: Frame3D | dict
) -> None:
    """Register each topology surface as a face-typed plane in the global repository.

    New geometry types introduced here must also be added to _TYPE_HIERARCHY in query.py.
    """
    if isinstance(plane_obj, Frame3D):
        x_axis = plane_obj.x_axis
        y_axis = plane_obj.y_axis
        normal = plane_obj.normal
        origin = plane_obj.origin
    else:
        x_axis = plane_obj["x_axis"]
        y_axis = plane_obj["y_axis"]
        normal = plane_obj["normal"]
        origin = plane_obj["origin"]

    for surface in topology.get("surfaces", []):
        query = surface.get("query")
        if not query or not query.startswith("?"):
            continue

        # Area-weighted centroid of the surface boundary in 2D sketch coords,
        # then projected to world space. Endpoint averaging was wrong for curved
        # or asymmetric boundaries (only correct by symmetry for circles/rects).
        boundary = surface["boundary"]
        if boundary:
            u, v = _loop_centroid(boundary)
            world_origin = _sketch_to_world_2d([u, v], plane_obj)
        else:
            world_origin = list(origin)

        ids, _ = _parse_ancestry(query)
        key = frozenset(ids)
        existing_ids = global_repo.ancestral.get(key, [])
        if any(global_repo.elements.get(eid) == {
            "type": "flatface",
            "origin": world_origin,
            "x_axis": list(x_axis),
            "y_axis": list(y_axis),
            "normal": list(normal),
        } for eid in existing_ids):
            continue
        _evict_ancestry_and_register(
            global_repo, ids,
            {
                "type": "flatface",
                "origin": world_origin,
                "x_axis": list(x_axis),
                "y_axis": list(y_axis),
                "normal": list(normal),
            },
        )


def _register_topology_edges(
    global_repo: Repository, topology: dict, plane_obj: Frame3D | dict
) -> None:
    """Register each topology edge with its ancestry query."""
    for edge in topology.get("edges", []):
        query = edge.get("query")
        if not query or not query.startswith("?"):
            continue

        world_start = _sketch_to_world_2d(edge.get("start", [0, 0]), plane_obj)
        world_end = _sketch_to_world_2d(edge.get("end", [0, 0]), plane_obj)

        edge_type = "straightedge" if edge.get("kind", "line") == "line" else "edge"
        edge_data = {
            "type": edge_type,
            "kind": edge.get("kind", "line"),
            "start": world_start,
            "end": world_end,
        }

        if "center" in edge:
            edge_data["center"] = _sketch_to_world_2d(edge["center"], plane_obj)
            edge_data["radius"] = edge["radius"]

        ids, _ = _parse_ancestry(query)
        key = frozenset(ids)
        existing_ids = global_repo.ancestral.get(key, [])
        if any(global_repo.elements.get(eid) == edge_data for eid in existing_ids):
            continue
        _evict_ancestry_and_register(global_repo, ids, edge_data)


def _register_sketch_feature(
    global_repo: Repository, feature_id: str, feature_result: dict
) -> None:
    """Register the sketch feature itself as a sketch-feature entity."""
    if not feature_id or "topology" not in feature_result:
        return
    global_repo.register_ancestor(
        [ref(feature_id)],
        {"type": "sketch-feature", "feature_id": feature_id},
    )


def _register_topology_vertices(
    global_repo: Repository, topology: dict, plane_obj: Frame3D | dict, feature_id: str = ""
) -> None:
    """Register each topology vertex with its ancestry query."""
    all_vertices = {}
    all_vertices.update(topology.get("vertices", {}))
    all_vertices.update(topology.get("intersection_points", {}))

    for vid, v in all_vertices.items():
        world_xy = _sketch_to_world_2d([v.get("x", 0), v.get("y", 0)], plane_obj)

        ancestor_ids = [vid, "vertex"]
        if feature_id:
            ancestor_ids.append(ref(feature_id))
        query = make_ancestry_query(ancestor_ids, "vertex")

        ids, _ = _parse_ancestry(query)
        vertex_data = {
            "type": "vertex",
            "x": world_xy[0],
            "y": world_xy[1],
            "z": world_xy[2],
        }
        key = frozenset(ids)
        existing_ids = global_repo.ancestral.get(key, [])
        if any(global_repo.elements.get(eid) == vertex_data for eid in existing_ids):
            continue
        _evict_ancestry_and_register(global_repo, ids, vertex_data)
