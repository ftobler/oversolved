"""geometry_boolean.py - Boolean operations re-exported from cadquery_ops."""

from __future__ import annotations

import logging

from oversolved.kernel.cadquery_ops import (  # noqa: F401
    boolean_cut,
    boolean_union,
    boolean_intersection,
    fuse_shapes,
)

logger = logging.getLogger(__name__)
