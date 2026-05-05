"""CAD kernel — solver, builder, geometry. No Flask dependency."""

from .builder import build
from .types3d import Body, BuildState, FeatureCheckpoint
from .geometry import (
    fuse_shapes,
    shape_to_step_file_buffer,
    shape_to_stl_file_buffer,
    solid_to_mesh,
    step_file_to_shape,
)

__all__ = [
    "build", "Body", "BuildState", "FeatureCheckpoint",
    "fuse_shapes", "shape_to_step_file_buffer", "shape_to_stl_file_buffer",
    "solid_to_mesh", "step_file_to_shape",
]
