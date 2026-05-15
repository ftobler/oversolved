from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, TYPE_CHECKING
import numpy as np

if TYPE_CHECKING:
    from OCP.TopoDS import TopoDS_Shape
    from cadquery.occ_impl.geom import Plane as CQPlane


@dataclass
class BrepDiff:
    """History from an OCP boolean operation, classifying output sub-shapes.

    Lists hold opaque OCP TopoDS handles (typed Any to keep the dataclass importable
    without OCP). Identity tests use TopoDS_Shape.IsSame(), not Python equality.

    new_*    : output sub-shapes with no preimage in either input (e.g. the inner
               walls of a cut). These should be tagged with the CUTTING feature's id.
    inherited_*: output sub-shapes whose preimage existed unchanged in the prior body.
               Keep the preimage's created_by (the body's original creator).
    modified_in_inputs: input shapes that the algorithm reported as Modified -- their
               output counterparts may have changed topology (e.g. an edge split).
    deleted_inputs: input shapes that disappeared in the output (e.g. a face fully
               absorbed by another).
    """
    new_faces: list[Any] = field(default_factory=list)
    inherited_faces: list[Any] = field(default_factory=list)
    new_edges: list[Any] = field(default_factory=list)
    inherited_edges: list[Any] = field(default_factory=list)
    modified_input_faces: list[Any] = field(default_factory=list)
    deleted_input_faces: list[Any] = field(default_factory=list)
    modified_input_edges: list[Any] = field(default_factory=list)
    deleted_input_edges: list[Any] = field(default_factory=list)


@dataclass
class Body:
    """A 3D solid body tracked through the feature stack."""
    id: str
    created_by: str
    modified_by: list[str] = field(default_factory=list)
    shape: TopoDS_Shape | None = None  # canonical internal type: TopoDS_Shape
    sketch_id: str = ""  # sketch feature that was extruded to create this body
    # Topological history from the most recent boolean op that touched this body.
    # None for bodies that haven't been through a boolean op (fresh extrudes, etc.).
    # See solver_arch.user.md §B-rep Operation Tracking.
    brep_diff: BrepDiff | None = None


@dataclass
class FeatureCheckpoint:
    """Cached state at a single feature boundary for partial rebuild."""
    spec: dict
    result: dict
    repo_snapshot: dict[str, Any]
    body_store_snapshot: dict[str, Body]  # shapes are mutable; use _copy_shape() to defensively copy


@dataclass
class BuildState:
    """Opaque cache passed from one build() call to the next."""
    feature_order: list[str]
    checkpoints: dict[str, FeatureCheckpoint]


@dataclass(frozen=True)
class Frame3D:
    """A right-handed 3D coordinate frame.

    Fields are read-only lists so callers cannot mutate the frame in-place
    (avoids aliasing bugs when the same frame is shared across the call stack).
    """
    origin: list[float]
    x_axis: list[float]
    y_axis: list[float]
    normal: list[float]

    @classmethod
    def from_dict(cls, d: Mapping[str, Any], /) -> Frame3D:
        for key in ("origin", "x_axis", "y_axis", "normal"):
            if key not in d:
                raise ValueError(f"Frame3D.from_dict missing field '{key}'")
            if len(d[key]) != 3:
                raise ValueError(
                    f"Frame3D.from_dict field '{key}' has {len(d[key])} elements, expected 3"
                )
        return cls(
            origin=list(d["origin"]),
            x_axis=list(d["x_axis"]),
            y_axis=list(d["y_axis"]),
            normal=list(d["normal"]),
        )

    @classmethod
    def from_arrays(
        cls,
        origin: np.ndarray,
        x_axis: np.ndarray,
        y_axis: np.ndarray,
        normal: np.ndarray,
        /,
    ) -> Frame3D:
        return cls(
            origin=origin.tolist(),
            x_axis=x_axis.tolist(),
            y_axis=y_axis.tolist(),
            normal=normal.tolist(),
        )

    def to_dict(self) -> dict:
        return {
            "origin": self.origin,
            "x_axis": self.x_axis,
            "y_axis": self.y_axis,
            "normal": self.normal,
        }

    @classmethod
    def from_plane_transform(cls, pt: dict, /) -> Frame3D:
        rot = pt["rotation"]
        return cls(
            origin=list(pt["origin"]),
            x_axis=list(rot[0:3]),
            y_axis=list(rot[3:6]),
            normal=list(rot[6:9]),
        )

    def to_plane_transform(self) -> dict:
        return {
            "rotation": self.x_axis + self.y_axis + self.normal,
            "origin": self.origin,
        }

    @classmethod
    def from_cq_plane(cls, plane: CQPlane, /) -> Frame3D:
        return cls(
            origin=list(plane.origin.toTuple()),
            x_axis=list(plane.xDir.toTuple()),
            y_axis=list(plane.yDir.toTuple()),
            normal=list(plane.zDir.toTuple()),
        )

    def to_cq_plane(self) -> Any:
        from cadquery.occ_impl.geom import Plane as CQPlane
        return CQPlane(
            origin=(self.origin[0], self.origin[1], self.origin[2]),
            xDir=(self.x_axis[0], self.x_axis[1], self.x_axis[2]),
            normal=(self.normal[0], self.normal[1], self.normal[2]),
        )

    @classmethod
    def from_normal(cls, normal: list[float], origin: list[float] | None = None, /) -> Frame3D:
        nx, ny, nz = normal
        if abs(nz) < 0.9:
            ax, ay, az = 0.0, 0.0, 1.0
        else:
            ax, ay, az = 1.0, 0.0, 0.0
        cx = ny * az - nz * ay
        cy = nz * ax - nx * az
        cz = nx * ay - ny * ax
        mag = (cx * cx + cy * cy + cz * cz) ** 0.5
        if mag > 1e-12:
            cx, cy, cz = cx / mag, cy / mag, cz / mag
        else:
            cx, cy, cz = 1.0, 0.0, 0.0
        yx = ny * cz - nz * cy
        yy = nz * cx - nx * cz
        yz = nx * cy - ny * cx
        o = origin if origin is not None else [0.0, 0.0, 0.0]
        return cls(origin=o, x_axis=[cx, cy, cz], y_axis=[yx, yy, yz], normal=[nx, ny, nz])


FRONT: Frame3D = Frame3D(origin=[0, 0, 0], x_axis=[1, 0, 0], y_axis=[0, 1, 0], normal=[0, 0, 1])
TOP: Frame3D = Frame3D(origin=[0, 0, 0], x_axis=[1, 0, 0], y_axis=[0, 0, -1], normal=[0, 1, 0])
RIGHT: Frame3D = Frame3D(origin=[0, 0, 0], x_axis=[0, 0, -1], y_axis=[0, 1, 0], normal=[1, 0, 0])
