from dataclasses import dataclass, field
from typing import Any


@dataclass
class Body:
    """A 3D solid body tracked through the feature stack."""
    id: str
    created_by: str
    modified_by: list[str] = field(default_factory=list)
    shape: Any = None  # TopoDS_Shape when OCC is available, else None
    sketch_id: str = ""  # sketch feature that was extruded to create this body


@dataclass
class FeatureCheckpoint:
    """Cached state at a single feature boundary for partial rebuild."""
    spec: dict
    result: dict
    repo_snapshot: dict[str, Any]
    body_store_snapshot: dict[str, 'Body']  # shallow copy (shapes are immutable)


@dataclass
class BuildState:
    """Opaque cache passed from one build() call to the next."""
    feature_order: list[str]
    checkpoints: dict[str, 'FeatureCheckpoint']


@dataclass
class FilletFeatureDef:
    """Fillet feature definition - rounds edges with a specified radius."""
    edges: list[str]  # edge queries, e.g. ["?body_0:edge:0"]
    radius: float


@dataclass
class ChamferFeatureDef:
    """Chamfer feature definition - bevels edges at a specified distance/angle."""
    edges: list[str]
    distance: float
    kind: str = "distance"  # "distance" | "angle_distance"
    angle: float = 45.0  # degrees
