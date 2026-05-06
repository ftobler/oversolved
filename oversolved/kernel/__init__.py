"""CAD kernel — solver, builder, geometry. No Flask dependency."""

from .builder import build  # noqa: F401
from .types3d import Body, BuildState, FeatureCheckpoint  # noqa: F401
