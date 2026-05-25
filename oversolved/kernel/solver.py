"""Public solver facade.

This module is the single stable import surface for the CAD solver.
All callers should import from ``oversolved.kernel.solver``; the submodules
(solver_plane, solver_registry, solver_features_*, etc.) are implementation
details and may change without notice.
"""

import logging
import math
import threading
import time
import traceback
from typing import Any, Callable
import yaml
import numpy as np
from scipy.optimize import least_squares
from oversolved.kernel.topology import detect_topology
from oversolved.kernel.query import Repository, _init_global_repo  # noqa: F401
from oversolved.kernel.solver_constants import (
    _FRONT_PLANE, ENTITY_SIZES, LOSS_THRESHOLD, RANK_TOL, RANK_BOUNDARY_TOL,
    ORIGIN_ID, ORIGIN_FIX_ID, _BUILTIN_PLANES, _BUILTIN_PLANE_RESULTS,
    _PROJECTED_KINDS, _FACE_TYPES, REG_WEIGHT_BASE, REG_WEIGHT_DRAG,
)
from oversolved.kernel.solver_plane import (  # noqa: F401
    is_plane_type, is_point_type, _resolve_plane_early,
    _2d_to_3d, _3d_to_2d, _source_sketch_id,
    _resolve_source_geometry, _project_source_to_params,
    _get_point_3d, _get_edge_3d, _normalize,
    _rotate_frame_around_normal,
    _plane_three_point, _plane_on_face, _plane_on_face_edge_angle,
    _plane_edge_point, _plane_through_point, _plane_line_angle,
    _plane_offset, _solve_plane,
)
from oversolved.kernel.solver_registry import (  # noqa: F401
    _clear_feature_geometry_registrations,
    _post_register, _enrich_geometry,
    _register_solved_geometry_slash,
    _plane_transform,
    _register_topology_surfaces, _register_topology_edges,
    _register_topology_vertices, _register_sketch_feature,
)
from oversolved.kernel.solver_residuals import _build_residuals_fn
from oversolved.kernel.solver_render import _constraint_render
from oversolved.kernel.solver_features_brep import _solve_extrude, _solve_revolve  # noqa: F401
from oversolved.kernel.solver_features_array import _solve_array  # noqa: F401
from oversolved.kernel.solver_features_import import _solve_import_step  # noqa: F401
from oversolved.kernel.solver_features_fillet_chamfer import _solve_fillet, _solve_chamfer  # noqa: F401
from oversolved.kernel.solver_features_boolean import _solve_boolean  # noqa: F401
from oversolved.kernel.solver_features_delete import _solve_delete_body  # noqa: F401
from oversolved.kernel.solver_features_hole import _solve_hole  # noqa: F401
from oversolved.kernel.solver_features_transform_mirror import _solve_transform, _solve_mirror  # noqa: F401
from oversolved.kernel.solver_features_shared import _extract_profile_loops, _resolve_body  # noqa: F401

logger = logging.getLogger(__name__)

__all__ = [
    "solve",
    "solve_features",
    "_try_solve_feature",
    "_init_global_repo",
    "_post_register",
    "_resolve_projections",
]


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
    features_by_id = {f["id"]: f for f in features}

    t0 = time.perf_counter()
    result = {}
    body_store: dict = {}
    for feature in features:
        feature_result = _try_solve_feature(feature, global_repo, body_store, features_by_id)
        result[feature["id"]] = feature_result
        _post_register(global_repo, feature["id"], feature, feature_result)

    total_ms = round((time.perf_counter() - t0) * 1000, 1)
    result.update(_BUILTIN_PLANE_RESULTS)
    return {"solve_ms": total_ms, "result": result}


def solve_features(spec: dict) -> dict:
    """Solve a spec dict and return results as a list indexed by feature position.

    Returns {'features': [result_per_feature, ...]}.
    Results for plane features include 'plane' key; sketches include 'geometry'.
    """
    features = spec.get("features", [])

    global_repo = _init_global_repo()
    features_by_id = {f["id"]: f for f in features}
    body_store: dict = {}

    results = []
    for feature in features:
        feature_result = _try_solve_feature(feature, global_repo, body_store, features_by_id)
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


def _maybe_add_plane_transform(result: dict, feature: dict, global_repo: Repository) -> None:
    """Best-effort: resolve sketch plane and add plane_transform to the error result.
    Never raises -- the original error is the one the caller needs to see."""
    if not isinstance(feature, dict) or feature.get("kind") != "sketch":
        return
    try:
        feature_id = feature.get("id", "")
        entities = {e["id"]: e for e in feature.get("entities", [])}
        repo = _get_or_build_repo(feature_id, entities)

        def resolve_ref(val: object) -> object:
            if isinstance(val, str):
                r = repo.query(val, context=feature_id)
                if r is None and global_repo is not None:
                    r = global_repo.query(val, context=feature_id)
                return r
            return val

        plane_obj = _resolve_sketch_plane(feature.get("plane"), resolve_ref, global_repo)
        result["plane_transform"] = _plane_transform(plane_obj)
    except Exception:
        pass


def _try_solve_feature(feature: dict, global_repo: Repository, body_store: dict,
                       features_by_id: dict[str, dict] | None = None) -> dict:
    t0 = time.perf_counter()
    try:
        result = _solve_feature(feature, global_repo, body_store, features_by_id)
        result["solve_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        return result
    except Exception as e:
        feature_id = feature.get("id", "?") if isinstance(feature, dict) else "?"
        logger.warning("Exception solving feature %s: %s\n%s", feature_id, e, traceback.format_exc())
        result = {
            "solve_ms": round((time.perf_counter() - t0) * 1000, 1),
            "status": "exception",
            "exception": str(e),
        }
        _maybe_add_plane_transform(result, feature, global_repo)
        return result


def _dispatch_sketch(feature: dict, global_repo: Repository, body_store: dict, features_by_id: dict[str, dict]) -> dict:
    return _solve_sketch(feature, global_repo)


def _dispatch_hole(feature: dict, global_repo: Repository, body_store: dict, features_by_id: dict[str, dict]) -> dict:
    return _solve_hole(feature, global_repo, body_store, features_by_id)


def _make_body_store_dispatcher(fn: Callable) -> Callable:
    def _dispatch(feature: dict, global_repo: Repository, body_store: dict, features_by_id: dict[str, dict]) -> dict:
        return fn(feature, global_repo, body_store)
    return _dispatch


# Populated after _solve_sketch is defined at module bottom; see _build_feature_handlers().
_FEATURE_HANDLERS: dict[str, Callable] = {}


def _build_feature_handlers() -> None:
    _FEATURE_HANDLERS.update({
        "sketch": _dispatch_sketch,
        "plane": _make_body_store_dispatcher(_solve_plane),
        "extrude": _make_body_store_dispatcher(_solve_extrude),
        "import_step": _make_body_store_dispatcher(_solve_import_step),
        "fillet": _make_body_store_dispatcher(_solve_fillet),
        "chamfer": _make_body_store_dispatcher(_solve_chamfer),
        "revolve": _make_body_store_dispatcher(_solve_revolve),
        "array": _make_body_store_dispatcher(_solve_array),
        "boolean": _make_body_store_dispatcher(_solve_boolean),
        "delete_body": _make_body_store_dispatcher(_solve_delete_body),
        "hole": _dispatch_hole,
        "transform": _make_body_store_dispatcher(_solve_transform),
        "mirror": _make_body_store_dispatcher(_solve_mirror),
    })


def _solve_feature(feature: dict, global_repo: Repository, body_store: dict,
                   features_by_id: dict[str, dict] | None = None) -> dict:
    kind = feature.get("kind")
    handler = _FEATURE_HANDLERS.get(kind)  # type: ignore[arg-type]
    if handler is None:
        raise ValueError(f"unknown feature kind: {kind!r}")
    return handler(feature, global_repo, body_store, features_by_id or {})


# ─── Geometry helpers ───


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
    """Return flat parameter arrays per entity -- same format as the input `initial` block."""
    out = {}
    for eid, entity in entities.items():
        off = entity_offsets[eid]
        size = ENTITY_SIZES[entity["kind"]]
        out[eid] = [round(float(v), 10) for v in x[off:off + size]]
    return out


def _entity_status(J, rank, entities, entity_offsets, n_params, overall_status):
    """Return per-entity 'fully_constrained' | 'underconstrained' | 'overconstrained'.

    For each entity, temporarily pin all its parameters (augment J with identity
    rows for those columns).  If the rank increases, those parameters had free
    DOF -- the entity is underconstrained.  This matches CAD UX: an element is
    blue whenever any of its DOF are unconstrained, including position freedom
    in a freely-floating (no fixed) sketch.
    """
    if overall_status == "overconstrained":
        return {eid: "overconstrained" for eid in entities}

    if overall_status == "fully_constrained":
        return {eid: "fully_constrained" for eid in entities}

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


# ─── Sketch solver ───

def _expand_center_rect(feature: dict) -> dict:
    """Normalize center_rect sugar into 4 plain line entities so the solver sees a uniform entity set."""
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


# ─── Repo structure cache ───
# Single-entry LRU: only the most-recently-built Repository is retained.
# This avoids rebuilding for repeated calls with the same sketch structure
# while bounding memory to one cached object.

_last_repo_structure: tuple[tuple, Repository] | None = None
_last_repo_structure_lock = threading.Lock()


def _build_repo_structure_key(feature_id: str, entities: dict) -> tuple:
    items = tuple(sorted((eid, e["kind"]) for eid, e in entities.items()))
    return (feature_id, items)


def _get_or_build_repo(feature_id: str, entities: dict) -> Repository:
    global _last_repo_structure
    key = _build_repo_structure_key(feature_id, entities)
    with _last_repo_structure_lock:
        entry = _last_repo_structure
        if entry is not None and entry[0] == key:
            return entry[1]
    repo = Repository()
    repo.register("builtin_origin", {"entity": ORIGIN_ID, "point": "xy"})
    for name, plane in _BUILTIN_PLANES.items():
        repo.register(name, plane)
    for eid, entity in entities.items():
        kind = entity["kind"]
        repo.register(feature_id + eid, {"entity": eid})
        if kind == "line":
            repo.register(feature_id + eid + "start", {"entity": eid, "point": "start"})
            repo.register(feature_id + eid + "end", {"entity": eid, "point": "end"})
        elif kind == "circle":
            repo.register(feature_id + eid + "center", {"entity": eid, "point": "center"})
        elif kind == "arc":
            repo.register(feature_id + eid + "start", {"entity": eid, "point": "start"})
            repo.register(feature_id + eid + "end", {"entity": eid, "point": "end"})
            repo.register(feature_id + eid + "center", {"entity": eid, "point": "center"})
        elif kind == "point":
            repo.register(feature_id + eid + "xy", {"entity": eid, "point": "xy"})
    with _last_repo_structure_lock:
        _last_repo_structure = (key, repo)
    return repo


def _resolve_projections(
    feature: dict,
    global_repo: Repository | None,
    initial: dict,
    constraints: list,
) -> set[str]:
    """Resolve projected entity coordinates from their source queries.

    Called before the constraint residual build so projected entities have
    fixed coordinates that are pinned inputs to the solver.

    Returns the set of projected entity IDs.
    """
    return _process_projected_entities(feature, global_repo, initial, constraints)


def _process_projected_entities(
    feature: dict,
    global_repo: Repository | None,
    initial: dict,
    constraints: list,
) -> set[str]:
    """Pre-compute projected entity params and add implicit fixed constraints.

    Returns the set of projected entity IDs.
    """
    projected_ids: set = set()
    if global_repo is None:
        return projected_ids

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
                projected_ids.add(eid)
            except Exception as e:
                logger.warning(
                    "Projection failed for entity %s in sketch %s: %s",
                    eid, feature.get("id", "?"), e,
                )
    return projected_ids


_REF_FIELDS = ("target", "line", "arc", "point", "a", "b", "point_a", "point_b")


def _resolve_sketch_plane(
    plane_query: str | None,
    resolve_ref: Callable,
    global_repo: Repository | None,
) -> dict:
    """Resolve plane query to plane transform dict."""
    if not plane_query:
        raise ValueError("sketch has no plane assignment")

    plane_obj = resolve_ref(plane_query)
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
    return plane_obj


def _filter_local_constraints(
    constraints: list,
    entities: dict,
    resolve_ref: Callable,
    plane_obj: dict,
) -> tuple[list, list]:
    """Filter constraints to those referencing local entities.

    Three-stage filter:
    1. Keep only constraints whose entity IDs are all in entities.
    2. Pre-resolve all query strings to dict refs.
    3. Remove constraints that don't have valid local entity targets.

    Returns (filtered_constraints, unresolved_refs).
    """
    def _constraint_entity_ids(c: dict) -> list:
        ids = []
        for key in _REF_FIELDS:
            val = c.get(key)
            if val is None:
                continue
            ref = resolve_ref(val)
            if isinstance(ref, dict) and "entity" in ref:
                ids.append(ref["entity"])
            elif isinstance(ref, dict) and "external_xy" in ref:
                pass
            elif isinstance(ref, dict) and "external_params" in ref:
                pass
            elif isinstance(ref, dict) and ref.get("type") in _FACE_TYPES:
                pass
            else:
                ids.append(None)
        return ids

    constraints = [
        c
        for c in constraints
        if all(eid in entities for eid in _constraint_entity_ids(c))
    ]

    unresolved_refs = []

    def _pre_resolve(c: dict) -> dict:
        rc = dict(c)
        constraint_id = c.get("id", "(unknown)")
        constraint_kind = c.get("kind", "(unknown)")
        for field in _REF_FIELDS:
            if field in rc and isinstance(rc[field], str):
                ref = rc[field]
                resolved = resolve_ref(ref)
                if resolved is not None:
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

    def _has_valid_local_target(c: dict) -> bool:
        kind = c.get("kind", "")
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
            "normal",
            "angle",
        }
        if kind not in needs_local_entity:
            return True
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
    return constraints, unresolved_refs


def _run_solver(
    x0: np.ndarray,
    residuals_fn: Callable,
    constraints: list,
    entities: dict,
    entity_offsets: dict,
) -> tuple[np.ndarray, str, np.ndarray, int, float, int]:
    """Run scipy least_squares, compute status, rank, DOF.

    Returns (x_sol, status, J, rank, final_loss, n_params).
    """
    opt = least_squares(
        residuals_fn,
        x0,
        method="trf",
        jac="3-point",
        ftol=1e-10,
        xtol=1e-10,
        gtol=1e-10,
        max_nfev=10000,
        x_scale="jac",
    )
    x_sol = opt.x
    final_loss = 2.0 * float(opt.cost)

    J = (
        opt.jac
        if opt.jac is not None and opt.jac.shape[0] > 0
        else np.zeros((0, len(x_sol)))
    )
    rank = int(np.linalg.matrix_rank(J, tol=RANK_TOL))
    n_params = len(x_sol)

    n_fixed_pinned = sum(
        ENTITY_SIZES[entities[c["target"]["entity"]]["kind"]]
        if "point" not in c.get("target", {}) and "x" not in c and "y" not in c
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

    boundary_distance = (n_params - rigid_body_dof) - rank
    if 0 < boundary_distance <= RANK_BOUNDARY_TOL and final_loss <= LOSS_THRESHOLD:
        logger.warning(
            "rank near DOF boundary (rank=%d, expected=%d, rigid_body_dof=%d) — "
            "classification may be fragile",
            rank, n_params - rigid_body_dof, rigid_body_dof,
        )

    return x_sol, status, J, rank, final_loss, n_params


def _detect_superfluous_constraints(
    J: np.ndarray,
    constraint_row_ranges: list[tuple[str, int, int]],
    origin_fix_rows: set[int],
) -> set[str]:
    """Greedily detect superfluous constraints. Returns set of superfluous constraint IDs."""
    superfluous_ids: set[str] = set()
    if J.shape[0] == 0:
        return superfluous_ids

    active_rows = [r for r in range(J.shape[0]) if r not in origin_fix_rows]
    rank_active = None
    for cid, start, end in constraint_row_ranges:
        crows = list(range(start, end))
        remaining = [r for r in active_rows if r not in crows]
        if rank_active is None:
            J_active = J[active_rows + list(origin_fix_rows), :]
            rank_active = int(np.linalg.matrix_rank(J_active, tol=RANK_TOL))
        J_remaining = J[remaining + list(origin_fix_rows), :]
        if int(np.linalg.matrix_rank(J_remaining, tol=RANK_TOL)) == rank_active:
            superfluous_ids.add(cid)
            active_rows = remaining
            rank_active = None
    return superfluous_ids


def _drag_reg_weights(
    feature: dict, entities: dict, entity_offsets: dict, n_params: int,
) -> np.ndarray | None:
    """Per-parameter regularization weights for a drag re-solve.

    Returns None when the feature carries no drag_anchor hint, leaving normal
    solves untouched. Otherwise every parameter gets REG_WEIGHT_BASE and the
    dragged entities' parameters get the firmer REG_WEIGHT_DRAG.
    """
    anchor = feature.get("drag_anchor")
    if not anchor:
        return None
    dragged = {anchor} if isinstance(anchor, str) else set(anchor)
    weights = np.full(n_params, REG_WEIGHT_BASE, dtype=np.float64)
    for eid in dragged:
        if eid not in entity_offsets or eid not in entities:
            continue
        off = entity_offsets[eid]
        size = ENTITY_SIZES[entities[eid]["kind"]]
        weights[off:off + size] = REG_WEIGHT_DRAG
    return weights


def _refine_drag(
    x_clean: np.ndarray, x0: np.ndarray, residuals_fn: Callable, reg_weights: np.ndarray,
) -> np.ndarray:
    """Re-position free DOF after a drag without disturbing the constraint status.

    Runs a second least_squares seeded at the constraint solution ``x_clean``,
    adding linear penalty rows w*(x - x0) that pull each parameter toward its
    pre-solve value (firmest for the dragged entity). Hard constraints keep
    weight 1.0 and dominate, so the manifold is preserved; the penalty only
    selects a point within the free DOF. The status/rank/loss reported to the
    caller come from the unregularized solve, so this never raises a false
    overconstrained error.
    """
    reg_idx = np.flatnonzero(reg_weights)
    if reg_idx.size == 0:
        return x_clean
    reg_w = reg_weights[reg_idx]
    x0_reg = x0[reg_idx]

    def opt_residuals(x: np.ndarray) -> np.ndarray:
        return np.concatenate([residuals_fn(x), reg_w * (x[reg_idx] - x0_reg)])

    opt = least_squares(
        opt_residuals, x_clean,
        method="trf", jac="3-point",
        ftol=1e-10, xtol=1e-10, gtol=1e-10, max_nfev=10000, x_scale="jac",
    )
    return opt.x


def _solve_sketch(feature: dict, global_repo: Repository | None = None) -> dict:
    # Expand compound entity kinds before processing.
    if any(e.get("kind") == "center_rect" for e in feature.get("entities", [])):
        feature = _expand_center_rect(feature)

    entities = {e["id"]: e for e in feature["entities"]}
    initial = dict(feature.get("initial", {}))
    constraints_base = list(feature.get("constraints", []))

    projected_ids = _process_projected_entities(feature, global_repo, initial, constraints_base)
    if projected_ids:
        logger.debug(
            "sketch %s: projected entity IDs: %s",
            feature.get("id", "?"), projected_ids,
        )

    # Inject the projected origin point -- always present at (0, 0), not user-editable.
    entities[ORIGIN_ID] = {"id": ORIGIN_ID, "kind": "point", "projected": True}

    entity_offsets: dict = {}
    params: list = []
    for eid, entity in entities.items():
        entity_offsets[eid] = len(params)
        size = ENTITY_SIZES[entity["kind"]]
        params.extend(initial.get(eid, [0.0] * size))

    feature_id = feature.get("id", "")
    repo = _get_or_build_repo(feature_id, entities)

    def resolve_ref(val):
        if isinstance(val, str):
            result = repo.query(val, context=feature_id)
            if result is None and global_repo is not None:
                result = global_repo.query(val, context=feature_id)
            return result
        return val

    plane_obj = _resolve_sketch_plane(feature.get("plane"), resolve_ref, global_repo)
    constraints_active, unresolved_refs = _filter_local_constraints(
        constraints_base, entities, resolve_ref, plane_obj,
    )

    # Implicit constraint: pin the projected origin to (0, 0).
    constraints_active.append(
        {
            "id": ORIGIN_FIX_ID,
            "kind": "fixed",
            "target": {"entity": ORIGIN_ID, "point": "xy"},
            "x": 0.0,
            "y": 0.0,
        }
    )

    x0 = np.array(params, dtype=np.float64)
    reg_weights = _drag_reg_weights(feature, entities, entity_offsets, len(params))
    residuals_fn, _ = _build_residuals_fn(constraints_active, entities, entity_offsets, x0)
    x_sol, status, J, rank, _final_loss, n_params = _run_solver(
        x0, residuals_fn, constraints_active, entities, entity_offsets,
    )

    # Drag firmness: only re-position free DOF, and only when there are any.
    # Status/rank above stay authoritative, so a drag never fabricates an error.
    if reg_weights is not None and status == "underconstrained":
        x_sol = _refine_drag(x_sol, x0, residuals_fn, reg_weights)

    geom_solved = _geometry_from_array(x_sol, entities, entity_offsets)

    # Topology: detect intersection points and bounded surfaces
    topology = detect_topology(geom_solved, feature_id=feature_id)
    for vid, pt in topology["intersection_points"].items():
        geom_solved[vid] = {"x": pt["x"], "y": pt["y"], "intersection": True}

    # Per-entity status via null-space analysis.
    entity_status = _entity_status(J, rank, entities, entity_offsets, n_params, status)

    # Per-constraint residual, render data, and superfluous flag.
    constraint_row_ranges: list[tuple[str, int, int]] = []
    origin_fix_rows: set[int] = set()
    row_idx = 0
    for c in constraints_active:
        r_vec = residuals_fn(x_sol, [c])
        n = len(r_vec)
        if c["id"] == ORIGIN_FIX_ID:
            origin_fix_rows = set(range(row_idx, row_idx + n))
        else:
            constraint_row_ranges.append((c["id"], row_idx, row_idx + n))
        row_idx += n

    superfluous_ids = _detect_superfluous_constraints(J, constraint_row_ranges, origin_fix_rows)

    constraints_out = {}
    for c in constraints_active:
        if c["id"] == ORIGIN_FIX_ID:
            continue
        r_vec = residuals_fn(x_sol, [c])
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

    if unresolved_refs:
        result["warnings"] = [
            f"Constraint {r['constraint_id']} ({r['constraint_kind']}): "
            f"failed to resolve reference '{r['ref']}' in field '{r['field']}' "
            f"(constraint may be ineffective)"
            for r in unresolved_refs
        ]

    return result


_build_feature_handlers()
