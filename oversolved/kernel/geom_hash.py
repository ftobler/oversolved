"""Geometry hash functions for stable face/edge/vertex identity.

Hashes are computed from geometry attributes (centroid, normal for faces;
kind, start, end, angles for edges) rounded to 4 decimal places. The hash is
stable for any face/edge whose geometry doesn't change.

Digest length: 16 hex chars = 64 bits, giving ~4e9 faces before 50% collision
probability (birthday bound). Hashes are ephemeral per session -- never persisted.

Arc angle keys: topology-derived edges use 'angle_start_deg'/'angle_end_deg'
(degrees); OCC-extracted edges use 'angle_start'/'angle_end' (radians). Both
forms are accepted; radians are converted to degrees so hashes are unit-stable.
"""

import hashlib
import logging
import math

logger = logging.getLogger(__name__)


def is_geom_keyed_lineage(lineage: dict | None, prefix: str) -> bool:
    """True if a lineage map is keyed by stable geometry hashes (this feature),
    not the legacy OCC subshape hashes (decimal int strings).

    Producers re-keyed onto geometry hashes use 'gface_'/'gedge_' keys; a body
    whose lineage is still subshape-keyed reads as inert here, so callers keep
    the body-wide profile-query fallback for it (no regression) until its
    producer is re-keyed. *prefix* is 'gface_' for faces, 'gedge_' for edges.
    """
    if not lineage:
        return False
    return next(iter(lineage)).startswith(prefix)


def _r4str(v: float) -> str:
    """``str(round(v, 4))`` with negative zero normalized to ``"0.0"``.

    A geometry hash must not distinguish +0.0 from -0.0: they are the same point,
    but OCC builds disagree on the sign of a mathematically-zero coordinate (e.g.
    OCC.js emits a -0.0 arc x_axis component where OCP emits +0.0), which would
    otherwise flip the 4dp hash and break cross-kernel edge/face identity. Only an
    exact zero is touched; a small nonzero value that rounds to e.g. -0.0001 keeps
    its sign.
    """
    r = round(v, 4)
    if r == 0:
        r = abs(r)  # -0.0 -> 0.0 (abs of int 0 stays int 0, matching prior output)
    return str(r)


def _arc_angle_deg(edge: dict, start: bool) -> float:
    """Return arc angle in degrees, normalizing from radians if needed."""
    deg_key = "angle_start_deg" if start else "angle_end_deg"
    rad_key = "angle_start" if start else "angle_end"
    if deg_key in edge:
        return float(edge[deg_key])
    if rad_key in edge:
        return math.degrees(float(edge[rad_key]))
    return 0.0


def face_geometry_hash(centroid: list[float], normal: list[float]) -> str:
    """Return e.g. 'gface_a3f9b2c18d4e5f6a' from centroid + normal rounded to 4 dp.

    Inputs must come from exact geometry (GProp center-of-mass, surface-UV
    midpoint normal), never from the face triangulation.
    Area is deliberately excluded: it is summed from the face triangulation and
    so varies by ~1e-5 between tessellation passes (and across OCP versions),
    which flips the 4dp hash and breaks identity for a geometrically unchanged
    face. Centroid and normal are tessellation-stable and already discriminate
    the faces that the resolver must tell apart.
    """
    parts = [_r4str(v) for v in centroid]
    parts.extend(_r4str(v) for v in normal)
    digest = hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]
    return "gface_" + digest


def face_normal_hash(normal: list[float]) -> str:
    """Return e.g. 'gnormal_a3f9b2c18d4e5f6a' from the face normal alone.

    A weaker, orientation-only identity used as a resolve-time *fallback* for
    `face_geometry_hash`: when a face is reshaped so its centroid shifts (so the
    full centroid+normal hash goes stale) the normal often survives. Resolution
    tries the exact gface_ hash first and only falls back to this within the
    already-ancestry-matched candidate set, so it can never pick a face from an
    unrelated lineage.
    """
    parts = [_r4str(v) for v in normal]
    digest = hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]
    return "gnormal_" + digest


def _curve_data_items(curve_data: dict) -> list[str]:
    """Flatten exact curve data into a deterministic list of strings for hashing."""
    items = []
    for key in sorted(curve_data):
        val = curve_data[key]
        items.append(key)
        if isinstance(val, list):
            for element in val:
                if isinstance(element, list):
                    items.extend(_r4str(x) for x in element)
                else:
                    items.append(_r4str(element))
        elif isinstance(val, (int, float)):
            items.append(_r4str(val))
        else:
            items.append(str(val))
    return items


def edge_geometry_hash(edge: dict) -> str:
    """Return 'gedge_<hash>' for an edge dict.

    Arc edges include angle span to distinguish arcs with equal center/radius.
    Spline edges use exact curve data (NURBS control points, knots, etc.)
    rather than sampled points, so the hash is independent of tessellation
    settings like n_pts.
    """
    kind = edge.get("kind", "")
    items = [kind]
    if kind == "line":
        start, end = edge["start"], edge["end"]
        items.extend(_r4str(v) for pt in (start, end) for v in pt)
    elif kind in ("circle", "arc"):
        if kind == "arc":
            if "center" not in edge or "radius" not in edge:
                missing = [k for k in ("center", "radius") if k not in edge]
                logger.warning("arc edge missing %s, cannot hash: %s", missing, edge)
                raise ValueError(f"arc edge missing geometry fields: {missing}")
        items.append(_r4str(edge.get("radius", 0)))
        items.extend(_r4str(v) for v in edge.get("center", [0, 0, 0]))
        if kind == "arc":
            items.append(_r4str(_arc_angle_deg(edge, start=True)))
            items.append(_r4str(_arc_angle_deg(edge, start=False)))
            # Orientation pins which half of the circle the arc covers. OCC may
            # split a full circle into two arcs with identical center/radius and
            # angle span [0, pi] that differ only in axis/x_axis direction;
            # without these, the two halves collide to the same hash.
            items.extend(_r4str(v) for v in edge.get("axis", [0, 0, 1]))
            items.extend(_r4str(v) for v in edge.get("x_axis", [1, 0, 0]))
    else:
        curve_data = edge.get("curve_data")
        if curve_data:
            items.extend(_curve_data_items(curve_data))
        else:
            items.extend(_r4str(v) for pt in edge.get("points", [[0, 0, 0]]) for v in pt)
    digest = hashlib.sha256("|".join(items).encode()).hexdigest()[:16]
    return "gedge_" + digest


def vertex_geometry_hash(pt: list[float]) -> str:
    """Return 'gvertex_<hash>'."""
    digest = hashlib.sha256("|".join(_r4str(v) for v in pt).encode()).hexdigest()[:16]
    return "gvertex_" + digest


# Fraction of a half-extent an element's representative point must clear, on an
# axis, to count as "on that side" of the body. 0.5 keeps it firmly to one end
# (caps/rims clear it easily; mid-body geometry stays unclassified on that axis).
_CLASSIFIER_REL = 0.5


def geometry_classifiers(
    point: list[float],
    center: list[float],
    half_extents: list[float],
    rel: float = _CLASSIFIER_REL,
) -> list[str]:
    """Return cardinal/axial classifier tokens ('cls_zp', 'cls_xn', ...).

    Coarse, edit-stable spatial role of a face/edge: for each world axis, emit a
    +/- token when the element's representative *point* sits clearly past the
    body AABB center on that axis. Used as a resolver tier between ancestry and
    the (edit-fragile) geometry hash; see geometric-classifiers.md.

    Stable under translation and per-axis scaling (the sign of the offset is
    preserved); not stable under body-reorienting rotation. Axes whose half
    extent is ~0 (degenerate) emit nothing.
    """
    tokens: list[str] = []
    for axis, name in enumerate("xyz"):
        h = half_extents[axis]
        if h <= 1e-9:
            continue
        offset = point[axis] - center[axis]
        if offset > rel * h:
            tokens.append("cls_" + name + "p")
        elif offset < -rel * h:
            tokens.append("cls_" + name + "n")
    return tokens
