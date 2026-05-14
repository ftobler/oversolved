from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from OCP.TopoDS import TopoDS_Shape


@dataclass
class Body:
    """A 3D solid body tracked through the feature stack."""
    id: str
    created_by: str
    modified_by: list[str] = field(default_factory=list)
    shape: TopoDS_Shape | None = None  # canonical internal type: TopoDS_Shape
    sketch_id: str = ""  # sketch feature that was extruded to create this body


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
