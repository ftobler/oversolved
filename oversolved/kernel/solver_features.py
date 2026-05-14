"""Feature solvers -- re-exports from split modules. Backward-compatibility shim."""
from __future__ import annotations

from oversolved.kernel.solver_features_shared import *  # noqa: F401, F403
from oversolved.kernel.solver_features_brep import *  # noqa: F401, F403
from oversolved.kernel.solver_features_fillet_chamfer import *  # noqa: F401, F403
from oversolved.kernel.solver_features_array import *  # noqa: F401, F403
from oversolved.kernel.solver_features_transform_mirror import *  # noqa: F401, F403
from oversolved.kernel.solver_features_boolean import *  # noqa: F401, F403
from oversolved.kernel.solver_features_delete import *  # noqa: F401, F403
from oversolved.kernel.solver_features_hole import *  # noqa: F401, F403
from oversolved.kernel.solver_features_import import *  # noqa: F401, F403

__all__ = [  # noqa: F405 (star imports)
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
