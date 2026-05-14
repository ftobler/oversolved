"""Geometry hash functions for stable face/edge/vertex identity.

Hashes are computed from geometry attributes (centroid, normal, area for faces;
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


def _arc_angle_deg(edge: dict, start: bool) -> float:
    """Return arc angle in degrees, normalizing from radians if needed."""
    deg_key = "angle_start_deg" if start else "angle_end_deg"
    rad_key = "angle_start" if start else "angle_end"
    if deg_key in edge:
        return float(edge[deg_key])
    if rad_key in edge:
        return math.degrees(float(edge[rad_key]))
    return 0.0


def face_geometry_hash(centroid: list[float], normal: list[float], area: float) -> str:
    """Return e.g. 'gface_a3f9b2c18d4e5f6a' from geometry attributes rounded to 4 dp."""
    parts = [str(round(v, 4)) for v in centroid]
    parts.extend(str(round(v, 4)) for v in normal)
    parts.append(str(round(area, 4)))
    digest = hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]
    return "gface_" + digest


def edge_geometry_hash(edge: dict) -> str:
    """Return 'gedge_<hash>' for an edge dict.

    Arc edges include angle span to distinguish arcs with equal center/radius.
    """
    kind = edge.get("kind", "")
    items = [kind]
    if kind == "line":
        start, end = edge["start"], edge["end"]
        items.extend(str(round(v, 4)) for pt in (start, end) for v in pt)
    elif kind in ("circle", "arc"):
        if kind == "arc":
            if "center" not in edge or "radius" not in edge:
                missing = [k for k in ("center", "radius") if k not in edge]
                logger.warning("arc edge missing %s, cannot hash: %s", missing, edge)
                raise ValueError(f"arc edge missing geometry fields: {missing}")
        items.append(str(round(edge.get("radius", 0), 4)))
        items.extend(str(round(v, 4)) for v in edge.get("center", [0, 0, 0]))
        if kind == "arc":
            items.append(str(round(_arc_angle_deg(edge, start=True), 4)))
            items.append(str(round(_arc_angle_deg(edge, start=False), 4)))
    else:
        items.extend(str(round(v, 4)) for pt in edge.get("points", [[0, 0, 0]]) for v in pt)
    digest = hashlib.sha256("|".join(items).encode()).hexdigest()[:16]
    return "gedge_" + digest


def vertex_geometry_hash(pt: list[float]) -> str:
    """Return 'gvertex_<hash>'."""
    digest = hashlib.sha256("|".join(str(round(v, 4)) for v in pt).encode()).hexdigest()[:16]
    return "gvertex_" + digest
