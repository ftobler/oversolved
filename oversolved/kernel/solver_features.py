"""Feature solvers -- re-exports from split modules. Backward-compatibility shim."""
from __future__ import annotations

from oversolved.kernel.solver_features_shared import (  # noqa: F401
    _apply_body_operation,
    _collect_extrude_loops,
    _extract_loops_from_occ_face,
    _extract_profile_loops,
    _register_top_face,
    _resolve_axis_query,
    _resolve_body,
    _resolve_direction,
    _resolve_direction_query,
    _resolve_face_index_via_hash,
    _resolve_face_profile,
    _resolve_merge_targets,
    _split_compound,
    _tessellate_edge,
)
from oversolved.kernel.solver_features_brep import (  # noqa: F401
    _solve_extrude,
    _solve_revolve,
)
from oversolved.kernel.solver_features_fillet_chamfer import (  # noqa: F401
    _apply_edge_feature,
    _resolve_fillet_edges,
    _solve_chamfer,
    _solve_fillet,
)
from oversolved.kernel.solver_features_array import (  # noqa: F401
    _build_array_transforms,
    _solve_array,
)
from oversolved.kernel.solver_features_transform_mirror import (  # noqa: F401
    _solve_mirror,
    _solve_transform,
)
from oversolved.kernel.solver_features_boolean import _solve_boolean  # noqa: F401
from oversolved.kernel.solver_features_delete import _solve_delete_body  # noqa: F401
from oversolved.kernel.solver_features_hole import _solve_hole  # noqa: F401
from oversolved.kernel.solver_features_import import _solve_import_step  # noqa: F401

__all__ = [
    "_apply_body_operation",
    "_apply_edge_feature",
    "_build_array_transforms",
    "_collect_extrude_loops",
    "_extract_loops_from_occ_face",
    "_extract_profile_loops",
    "_register_top_face",
    "_resolve_axis_query",
    "_resolve_body",
    "_resolve_direction",
    "_resolve_direction_query",
    "_resolve_face_index_via_hash",
    "_resolve_face_profile",
    "_resolve_fillet_edges",
    "_resolve_merge_targets",
    "_split_compound",
    "_solve_array",
    "_solve_boolean",
    "_solve_chamfer",
    "_solve_delete_body",
    "_solve_extrude",
    "_solve_fillet",
    "_solve_hole",
    "_solve_import_step",
    "_solve_mirror",
    "_solve_revolve",
    "_solve_transform",
    "_tessellate_edge",
]
