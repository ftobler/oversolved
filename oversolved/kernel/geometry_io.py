"""geometry_io.py - STEP/STL file I/O for CAD shapes."""

from __future__ import annotations

import os
import logging
import tempfile
from io import BytesIO
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from OCP.TopoDS import TopoDS_Shape

try:
    from cadquery.occ_impl import shapes as cq_shapes
except ImportError:
    cq_shapes = None  # type: ignore

from oversolved.kernel.cadquery_ops import _ensure_cq
from oversolved.kernel.ocp_ops import ocp_read_stl, ocp_write_stl

logger = logging.getLogger(__name__)

_TMP_DIR: str | None = os.environ.get("OVERSOLVED_TMP_DIR")


def step_file_to_shape(filepath: str, scale: float = 1.0) -> cq_shapes.Shape:
    """Read a STEP file and return a cadquery shape.

    Optionally applies a scaling factor.
    """
    import cadquery as cq  # noqa: PLC0415

    workplane = cq.importers.importStep(filepath)
    raw = workplane.val()
    if raw is None or not isinstance(raw, cq_shapes.Shape):
        raise ValueError(f"STEP file produced no shape: {filepath!r}")
    shape: cq_shapes.Shape = raw
    if scale != 1.0:
        shape = shape.scale(scale)
    return shape


def stl_file_to_shape(filepath: str) -> TopoDS_Shape:
    """Read an STL file and return an OCC shape.

    Uses OCP StlAPI_Reader directly since cadquery does not provide an STL importer.
    """
    return ocp_read_stl(filepath)


def shape_to_step_file(shape: TopoDS_Shape, filepath: str) -> None:
    """Write a shape to a STEP file."""
    cq_shape = _ensure_cq(shape)
    cq_shape.exportStep(filepath)
    if not os.path.isfile(filepath):
        raise ValueError(f"STEP write failed: file not created at {filepath!r}")


def shape_to_step_file_buffer(shape: TopoDS_Shape) -> BytesIO:
    """Write a shape to a STEP file in memory."""
    cq_shape = _ensure_cq(shape)
    with tempfile.NamedTemporaryFile(suffix=".step", delete=False, dir=_TMP_DIR) as tmp:
        tmp_path = tmp.name

    try:
        cq_shape.exportStep(tmp_path)
        if not os.path.isfile(tmp_path):
            raise ValueError("STEP write failed: file not created")
        with open(tmp_path, "rb") as f:
            buffer = BytesIO(f.read())
        buffer.seek(0)
        return buffer
    finally:
        if os.path.isfile(tmp_path):
            os.unlink(tmp_path)


def shape_to_stl_file_buffer(shape: TopoDS_Shape, deflection: float = 0.5, angular_deflection: float = 0.3) -> BytesIO:
    """Write a shape to an STL file in memory.

    Args:
        shape: The shape to export.
        deflection: Linear deflection for mesh tessellation (default 0.5).
        angular_deflection: Angular deflection for mesh tessellation (default 0.3 radians).
    """
    with tempfile.NamedTemporaryFile(suffix=".stl", delete=False, dir=_TMP_DIR) as tmp:
        tmp_path = tmp.name
    try:
        ocp_write_stl(shape, tmp_path, deflection, angular_deflection)
        with open(tmp_path, "rb") as f:
            buffer = BytesIO(f.read())
        buffer.seek(0)
        return buffer
    finally:
        os.unlink(tmp_path)


def shape_to_stl_file(shape: TopoDS_Shape, filepath: str,
                      deflection: float = 0.5, angular_deflection: float = 0.3) -> None:
    """Write a shape to an STL file.

    Args:
        shape: The shape to export.
        filepath: Path to write the STL file.
        deflection: Linear deflection for mesh tessellation (default 0.5).
        angular_deflection: Angular deflection for mesh tessellation (default 0.3 radians).
    """
    ocp_write_stl(shape, filepath, deflection, angular_deflection)
