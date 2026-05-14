"""geometry.py - re-export shim for backward compatibility."""
from __future__ import annotations

from oversolved.kernel.geometry_tessellation import (  # noqa: F401
    MeshDict, EdgeDict, VertexDict,
    signed_distance_to_line, point_in_circle,
    classify_surface_by_line_side, classify_surface_by_circle_side, classify_surface_cardinal,
    plane_dict_to_gp_pln, sketch_loops_to_face, extrude_profile, revolve_face,
    solid_to_mesh, solid_to_edges, solid_to_vertices,
    _validate_mesh,
    _sort_shape_faces, _append_face_triangles, _build_face_query,
    _unit_cube_mesh, _load_shape_from_path, _init_mesh_accumulators,
    _tessellate_and_assemble_faces,
)
from oversolved.kernel.geometry_io import (  # noqa: F401
    step_file_to_shape, stl_file_to_shape,
    shape_to_step_file, shape_to_step_file_buffer,
    shape_to_stl_file, shape_to_stl_file_buffer,
)
from oversolved.kernel.geometry_boolean import (  # noqa: F401
    boolean_cut, boolean_union, boolean_intersection, fuse_shapes,
)
from oversolved.kernel.geometry_features import (  # noqa: F401
    EdgeModifierResult,
    transform_copy, make_translation_trsf, make_rotation_trsf,
    apply_fillet, apply_chamfer,
    _apply_edge_modifier,
    _check_null_shape, _try_collect_edge_hashes, _try_create_maker,
    _try_add_edge, _try_build_shape,
)
from oversolved.kernel.cadquery_ops import extrude_face  # noqa: F401
from oversolved.kernel.profile_loops import classify_loops  # noqa: F401
