"""Geometry hash functions for stable face/edge/vertex identity.

Hashes are computed from geometry attributes (centroid, normal, area for faces;
kind, start, end for edges) rounded to 4 decimal places. The hash is stable
for any face/edge whose geometry doesn't change.
"""

import hashlib


def face_geometry_hash(centroid: list[float], normal: list[float], area: float) -> str:
    """Return e.g. 'gface_a3f9b2c18d4e' from geometry attributes rounded to 4 dp."""
    parts = [str(round(v, 4)) for v in centroid]
    parts.extend(str(round(v, 4)) for v in normal)
    parts.append(str(round(area, 4)))
    digest = hashlib.sha256("|".join(parts).encode()).hexdigest()[:12]
    return "gface_" + digest


def edge_geometry_hash(edge: dict) -> str:
    """Return 'gedge_<hash>' for an edge dict."""
    kind = edge.get("kind", "")
    items = [kind]
    if kind == "line":
        start, end = edge["start"], edge["end"]
        items.extend(str(round(v, 4)) for pt in (start, end) for v in pt)
    elif kind in ("circle", "arc"):
        items.append(str(round(edge.get("radius", 0), 4)))
        items.extend(str(round(v, 4)) for v in edge.get("center", [0, 0, 0]))
    else:
        items.extend(str(round(v, 4)) for pt in edge.get("points", [[0, 0, 0]]) for v in pt)
    digest = hashlib.sha256("|".join(items).encode()).hexdigest()[:12]
    return "gedge_" + digest


def vertex_geometry_hash(pt: list[float]) -> str:
    """Return 'gvertex_<hash>'."""
    digest = hashlib.sha256("|".join(str(round(v, 4)) for v in pt).encode()).hexdigest()[:12]
    return "gvertex_" + digest
