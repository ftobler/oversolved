"""Test-only fixture helper for building PartDoc dicts with human-readable IDs.

Production code uses random base-64url tokens (e.g. ``gJk7xQ_o2P``) as
feature and entity IDs.  Hand-written tests are unreadable with those names.
This module lets test authors supply their own names (``sketch1``, ``line1``,
``c1``) which are used verbatim as IDs -- the document never knows the
difference.

No production module imports this file.  The helper performs no runtime
substitution or registry: the names ARE the IDs.
"""

from __future__ import annotations

from typing import Any


def make_sketch(
    sketch_id: str,
    *,
    plane: str = "@builtin_plane_front",
    entities: list[dict[str, Any]] | None = None,
    constraints: list[dict[str, Any]] | None = None,
    initial: dict[str, list[float]] | None = None,
    label: str | None = None,
) -> dict[str, Any]:
    """Return a sketch feature dict with parseable IDs.

    ``sketch_id``, entity ``id`` values inside ``entities``, and constraint
    ``id`` values inside ``constraints`` are used exactly as supplied -- they
    serve as the storage IDs for this doc.

    Example::

        make_sketch(
            "sketch1",
            entities=[{"id": "line1", "kind": "line"}],
            constraints=[{"id": "c1", "kind": "horizontal",
                          "target": {"entity": "line1"}}],
            initial={"line1": [0, 0, 10, 0]},
        )
    """
    feat: dict[str, Any] = {
        "id": sketch_id,
        "kind": "sketch",
        "plane": plane,
        "entities": entities if entities is not None else [],
        "constraints": constraints if constraints is not None else [],
    }
    if initial is not None:
        feat["initial"] = initial
    if label is not None:
        feat["label"] = label
    return feat


def make_doc(*features: dict[str, Any]) -> dict[str, Any]:
    """Return a minimal PartDoc dict containing the supplied features.

    Example::

        doc = make_doc(
            make_sketch("sketch1", entities=[{"id": "line1", "kind": "line"}]),
        )
        assert doc["features"][0]["id"] == "sketch1"
    """
    return {
        "version": 1,
        "kind": "part",
        "features": list(features),
    }
