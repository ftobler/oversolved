"""topology.py — post-solve surface detection for sketch geometry.

Algorithm
---------
1. Find all pairwise intersection points between non-construction entities
   (line/line, line/circle, line/arc, circle/circle, circle/arc, arc/arc).
2. Split every entity at those points into edge segments.
3. Build a planar half-edge graph.
4. Traverse face cycles via DCEL next-half-edge rule.
5. Keep CCW (positive-area) cycles → bounded interior surfaces.

Standalone circles with no intersections are returned as single-boundary
surfaces directly.

Output
------
{
  "intersection_points": {id: {"x", "y"}},   # only the new intersection pts
  "vertices":            {id: {"x", "y"}},   # all graph vertices
  "surfaces": [
    {"boundary": [
       {"kind": "line"|"arc",
        "start": [x,y], "end": [x,y],
        # arc only:
        "center": [cx,cy], "radius": r,
        "angle_start_deg": …, "angle_end_deg": …, "ccw": bool,
        "start_vertex": vid, "end_vertex": vid},
       …
    ]},
    …
  ]
}
"""

import math
from typing import Any
from oversolved.query import make_ancestry_query

_EPS = 1e-9
_MERGE = 1e-7       # distance tolerance for vertex deduplication
_SPLIT_EPS = 1e-7   # parametric tolerance for split deduplication


# ── Geometry helpers ──────────────────────────────────────────────────────────

def _angle_in_arc(a_rad: float, start_deg: float, end_deg: float) -> bool:
    """True if angle a_rad lies inside arc [start_deg, end_deg] (CCW, degrees)."""
    s = math.radians(start_deg) % (2 * math.pi)
    e = math.radians(end_deg) % (2 * math.pi)
    a = a_rad % (2 * math.pi)
    if abs(s - e) < _EPS or abs(s - e) > 2 * math.pi - _EPS:   # full circle or near full circle
        return True
    if s < e:
        return s - _EPS <= a <= e + _EPS
    return a >= s - _EPS or a <= e + _EPS   # wraps past 0


def _arc_tangent(a_rad: float, ccw: bool = True) -> tuple:
    """Unit tangent on a circle at angle a_rad, going CCW or CW."""
    s = 1.0 if ccw else -1.0
    return (-s * math.sin(a_rad), s * math.cos(a_rad))


# ── Intersection primitives ───────────────────────────────────────────────────

def _ll(p1, p2, p3, p4):
    """Segment–segment → (t, u, pt) or None."""
    dx1, dy1 = p2[0] - p1[0], p2[1] - p1[1]
    dx2, dy2 = p4[0] - p3[0], p4[1] - p3[1]
    det = dx1 * dy2 - dy1 * dx2
    if abs(det) < _EPS:
        return None
    dx3, dy3 = p3[0] - p1[0], p3[1] - p1[1]
    t = (dx3 * dy2 - dy3 * dx2) / det
    u = (dx3 * dy1 - dy3 * dx1) / det
    if not (-_EPS <= t <= 1 + _EPS and -_EPS <= u <= 1 + _EPS):
        return None
    t, u = max(0., min(1., t)), max(0., min(1., u))
    return t, u, [p1[0] + t * dx1, p1[1] + t * dy1]


def _lc(p1, p2, cx, cy, r):
    """Segment–circle → list of (t, angle_rad, pt), t ∈ [0,1]."""
    dx, dy = p2[0] - p1[0], p2[1] - p1[1]
    fx, fy = p1[0] - cx, p1[1] - cy
    a = dx * dx + dy * dy
    if a < _EPS:
        return []
    b = 2 * (fx * dx + fy * dy)
    c = fx * fx + fy * fy - r * r
    disc = b * b - 4 * a * c
    if disc < 0:
        return []
    sd = math.sqrt(max(0., disc))
    out, seen = [], set()
    for sign in (-1, 1):
        raw = (-b + sign * sd) / (2 * a)
        if not (-_EPS <= raw <= 1 + _EPS):
            continue
        t = max(0., min(1., raw))
        key = round(t, 7)
        if key in seen:
            continue
        seen.add(key)
        ix, iy = p1[0] + t * dx, p1[1] + t * dy
        out.append((t, math.atan2(iy - cy, ix - cx), [ix, iy]))
    return out


def _cc(cx1, cy1, r1, cx2, cy2, r2):
    """Circle–circle → list of (angle1, angle2, pt)."""
    d = math.hypot(cx2 - cx1, cy2 - cy1)
    if d < _EPS or d > r1 + r2 + _EPS or d < abs(r1 - r2) - _EPS:
        return []
    a = (r1 * r1 - r2 * r2 + d * d) / (2 * d)
    h2 = r1 * r1 - a * a
    if h2 < 0:
        return []
    h = math.sqrt(max(0., h2))
    mx = cx1 + a * (cx2 - cx1) / d
    my = cy1 + a * (cy2 - cy1) / d
    ox = h * (cy2 - cy1) / d
    oy = h * (cx2 - cx1) / d
    pts = [(mx + ox, my - oy), (mx - ox, my + oy)]
    if h < _EPS:
        pts = pts[:1]
    return [(math.atan2(sy - cy1, sx - cx1), math.atan2(sy - cy2, sx - cx2), [sx, sy])
            for sx, sy in pts]


def _intersect(eid_a, ea, eid_b, eb, lines, circles, arcs):
    """All (param_a, param_b, pt) intersections between two entities."""
    ta = 'l' if eid_a in lines else ('c' if eid_a in circles else 'a')
    tb = 'l' if eid_b in lines else ('c' if eid_b in circles else 'a')

    def ia(e, ang): return _angle_in_arc(ang, e['angle_start'], e['angle_end'])

    if ta == 'l' and tb == 'l':
        r = _ll(ea['start'], ea['end'], eb['start'], eb['end'])
        return [(r[0], r[1], r[2])] if r else []

    if ta == 'l' and tb == 'c':
        return [(t, ang, pt)
                for t, ang, pt in _lc(ea['start'], ea['end'],
                                      ea if False else eb['center'][0], eb['center'][1], eb['radius'])
                # inline expand to avoid *-unpack confusion
                ] if False else [
            (t, ang, pt) for t, ang, pt in
            _lc(ea['start'], ea['end'], eb['center'][0], eb['center'][1], eb['radius'])
        ]

    if ta == 'c' and tb == 'l':
        return [(ang, t, pt) for t, ang, pt in
                _lc(eb['start'], eb['end'], ea['center'][0], ea['center'][1], ea['radius'])]

    if ta == 'l' and tb == 'a':
        return [(t, ang, pt) for t, ang, pt in
                _lc(ea['start'], ea['end'], eb['center'][0], eb['center'][1], eb['radius'])
                if ia(eb, ang)]

    if ta == 'a' and tb == 'l':
        return [(ang, t, pt) for t, ang, pt in
                _lc(eb['start'], eb['end'], ea['center'][0], ea['center'][1], ea['radius'])
                if ia(ea, ang)]

    if ta == 'c' and tb == 'c':
        return _cc(ea['center'][0], ea['center'][1], ea['radius'],
                   eb['center'][0], eb['center'][1], eb['radius'])

    if ta == 'c' and tb == 'a':
        return [(a1, a2, pt) for a1, a2, pt in
                _cc(ea['center'][0], ea['center'][1], ea['radius'],
                    eb['center'][0], eb['center'][1], eb['radius'])
                if ia(eb, a2)]

    if ta == 'a' and tb == 'c':
        return [(a1, a2, pt) for a1, a2, pt in
                _cc(ea['center'][0], ea['center'][1], ea['radius'],
                    eb['center'][0], eb['center'][1], eb['radius'])
                if ia(ea, a1)]

    if ta == 'a' and tb == 'a':
        return [(a1, a2, pt) for a1, a2, pt in
                _cc(ea['center'][0], ea['center'][1], ea['radius'],
                    eb['center'][0], eb['center'][1], eb['radius'])
                if ia(ea, a1) and ia(eb, a2)]

    return []


# ── Vertex registry ───────────────────────────────────────────────────────────

def _vid(verts: dict, pt) -> str:
    for k, v in verts.items():
        if (v[0] - pt[0]) ** 2 + (v[1] - pt[1]) ** 2 < _MERGE ** 2:
            return k
    k = f"_v{len(verts)}"
    verts[k] = [float(pt[0]), float(pt[1])]
    return k


def _has_param(spl, p: float) -> bool:
    return any(abs(s - p) < _SPLIT_EPS for s, _ in spl)


def _norm_arc_param(p: float, a0: float) -> float:
    """Shift angle p into [a0, a0 + 2π) so arc split params sort correctly."""
    while p < a0 - _SPLIT_EPS:
        p += 2 * math.pi
    while p >= a0 + 2 * math.pi - _SPLIT_EPS:
        p -= 2 * math.pi
    return p


def _dedup(spl):
    """Sort splits by param, remove consecutive duplicates."""
    if not spl:
        return spl
    spl = sorted(spl)
    out = [spl[0]]
    for p, v in spl[1:]:
        if abs(p - out[-1][0]) > _SPLIT_EPS:
            out.append((p, v))
    return out


# ── Half-edge geometry constructors ──────────────────────────────────────────

def _line_eg(e, t0: float, t1: float) -> dict:
    p1, p2 = e['start'], e['end']
    s = [p1[0] + t0 * (p2[0] - p1[0]), p1[1] + t0 * (p2[1] - p1[1])]
    d = [p1[0] + t1 * (p2[0] - p1[0]), p1[1] + t1 * (p2[1] - p1[1])]
    return {'kind': 'line', 'start': s, 'end': d}


def _arc_eg(e, a0: float, a1: float, ccw: bool = True) -> dict:
    cx, cy, r = e['center'][0], e['center'][1], e['radius']
    return {
        'kind': 'arc',
        'center': [cx, cy],
        'radius': r,
        'angle_start_deg': math.degrees(a0),
        'angle_end_deg': math.degrees(a1),
        'ccw': ccw,
        'start': [cx + r * math.cos(a0), cy + r * math.sin(a0)],
        'end':   [cx + r * math.cos(a1), cy + r * math.sin(a1)],
    }


def _rev(eg: dict) -> dict:
    """Reverse a half-edge geometry (swap start/end, flip arc direction)."""
    if eg['kind'] == 'line':
        return {'kind': 'line', 'start': eg['end'], 'end': eg['start']}
    return {
        **eg,
        'angle_start_deg': eg['angle_end_deg'],
        'angle_end_deg':   eg['angle_start_deg'],
        'ccw': not eg.get('ccw', True),
        'start': eg['end'],
        'end':   eg['start'],
    }


def _depart(egeom: dict, verts: dict, vf_id: str) -> float:
    """Departure angle of a half-edge leaving vertex vf_id."""
    if egeom['kind'] == 'line':
        s, d = egeom['start'], egeom['end']
        return math.atan2(d[1] - s[1], d[0] - s[0])
    a = math.radians(egeom['angle_start_deg'])
    tx, ty = _arc_tangent(a, egeom.get('ccw', True))
    return math.atan2(ty, tx)


# ── Signed area of a face cycle ───────────────────────────────────────────────

def _face_area(cycle, hes, verts) -> float:
    """Shoelace area, sampling arc midpoints for curved edges."""
    pts = []
    for i in cycle:
        vf, _vt, eg = hes[i]
        pts.append(verts[vf])
        if eg['kind'] == 'arc':
            a0 = math.radians(eg['angle_start_deg'])
            a1 = math.radians(eg['angle_end_deg'])
            if not eg.get('ccw', True):
                a0, a1 = a1, a0
            if a1 < a0:
                a1 += 2 * math.pi
            am = (a0 + a1) / 2
            cx, cy, r = eg['center'][0], eg['center'][1], eg['radius']
            pts.append([cx + r * math.cos(am), cy + r * math.sin(am)])
    n = len(pts)
    return sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1]
               for i in range(n)) / 2.0


# ── Main entry point ──────────────────────────────────────────────────────────

def detect_topology(geometry: dict, feature_id: str = '') -> dict:
    """Detect intersection points and bounded surfaces in solved sketch geometry."""

    lines, circles, arcs = {}, {}, {}
    for eid, e in geometry.items():
        if e.get('construction'):
            continue
        if 'start' in e and 'radius' in e:
            arcs[eid] = e
        elif 'start' in e:
            lines[eid] = e
        elif 'center' in e:
            circles[eid] = e

    verts: dict = {}     # vid -> [x, y]
    splits: dict = {}    # eid -> [(param, vid)]
    arc_a0: dict = {}    # eid -> arc start angle (for parameter normalisation)

    for eid, e in lines.items():
        splits[eid] = [(0.0, _vid(verts, e['start'])), (1.0, _vid(verts, e['end']))]

    for eid in circles:
        splits[eid] = []

    # Normalise CW arcs to CCW by swapping start/end angles and endpoints.
    # An arc is CW when its CCW span (going the "long way") exceeds 180°,
    # meaning the intended arc is actually the shorter CW path.
    # Swapping produces an equivalent CCW arc so the rest of the algorithm works uniformly.
    for eid in list(arcs.keys()):
        e = arcs[eid]
        a0_rad = math.radians(e['angle_start'])
        a1_rad = math.radians(e['angle_end'])
        ccw_span = (a1_rad - a0_rad) % (2 * math.pi)   # always in [0, 2π)
        if ccw_span > math.pi + _EPS:                   # > 180° → arc is actually CW
            arcs[eid] = {**e,
                         'angle_start': e['angle_end'],
                         'angle_end':   e['angle_start'],
                         'start': e['end'],
                         'end':   e['start']}

    for eid, e in arcs.items():
        a0 = math.radians(e['angle_start'])
        a1 = math.radians(e['angle_end'])
        # Normalise a1 into [a0, a0+2π) so that CCW arcs crossing 0° sort correctly.
        a1 = _norm_arc_param(a1, a0)
        arc_a0[eid] = a0
        splits[eid] = [(a0, _vid(verts, e['start'])), (a1, _vid(verts, e['end']))]

    # Track which vertex IDs come from entity endpoints (not intersections)
    endpoint_vids = set(verts.keys())

    # Find all pairwise intersections and record splits
    elist = (list(lines.items()) + list(circles.items()) + list(arcs.items()))
    for i in range(len(elist)):
        eid_a, ea = elist[i]
        for j in range(i + 1, len(elist)):
            eid_b, eb = elist[j]
            for pa, pb, pt in _intersect(eid_a, ea, eid_b, eb, lines, circles, arcs):
                v = _vid(verts, pt)
                # Normalise arc parameters so they sort within [a0, a0+2π)
                if eid_a in arc_a0:
                    pa = _norm_arc_param(pa, arc_a0[eid_a])
                if eid_b in arc_a0:
                    pb = _norm_arc_param(pb, arc_a0[eid_b])
                if not _has_param(splits[eid_a], pa):
                    splits[eid_a].append((pa, v))
                if not _has_param(splits[eid_b], pb):
                    splits[eid_b].append((pb, v))

    intersection_vids = set(verts.keys()) - endpoint_vids

    # Build half-edge list: (vfrom, vto, egeom)
    hes = []
    he_eid = []   # source entity ID for each half-edge (parallel to hes)

    for eid, e in lines.items():
        spl = _dedup(splits[eid])
        for k in range(len(spl) - 1):
            t0, v0 = spl[k]
            t1, v1 = spl[k + 1]
            if v0 == v1:
                continue
            eg = _line_eg(e, t0, t1)
            hes += [(v0, v1, eg), (v1, v0, _rev(eg))]
            he_eid += [eid, eid]

    for eid, e in arcs.items():
        spl = _dedup(splits[eid])
        for k in range(len(spl) - 1):
            a0, v0 = spl[k]
            a1, v1 = spl[k + 1]
            if v0 == v1:
                continue
            eg = _arc_eg(e, a0, a1, ccw=True)
            hes += [(v0, v1, eg), (v1, v0, _rev(eg))]
            he_eid += [eid, eid]

    for eid, e in circles.items():
        spl = _dedup(splits[eid])
        if len(spl) < 2:
            continue  # standalone — handled below
        for k in range(len(spl)):
            a0, v0 = spl[k]
            a1, v1 = spl[(k + 1) % len(spl)]
            if v0 == v1:
                continue
            if a1 <= a0:
                a1 += 2 * math.pi
            eg = _arc_eg(e, a0, a1, ccw=True)
            hes += [(v0, v1, eg), (v1, v0, _rev(eg))]
            he_eid += [eid, eid]

    surfaces: list[dict[str, Any]] = []

    if hes:
        # Outgoing half-edges per vertex, sorted by departure angle
        out_map: dict = {}
        for i, (vf, _vt, eg) in enumerate(hes):
            angle = _depart(eg, verts, vf)
            out_map.setdefault(vf, []).append((angle, i))
        for vid in out_map:
            out_map[vid].sort()

        # Half-edges are added in pairs (fwd, rev) at indices (2k, 2k+1),
        # so the twin of i is always i ^ 1.
        twin: dict = {i: i ^ 1 for i in range(len(hes))}

        # next[twin[i]] = outgoing edge at vf one step before i in CCW order
        # (i.e. the most clockwise turn when arriving via twin[i])
        next_he: dict = {}
        for vid, outs in out_map.items():
            k = len(outs)
            for pos, (_, i) in enumerate(outs):
                ti = twin.get(i)
                if ti is not None:
                    next_he[ti] = outs[(pos - 1) % k][1]

        # Trace face cycles
        visited: set = set()
        for start in range(len(hes)):
            if start in visited or start not in next_he:
                continue
            cycle, cur = [], start
            while cur not in visited and cur in next_he:
                visited.add(cur)
                cycle.append(cur)
                cur = next_he[cur]
                if cur == start:
                    break
            if cycle and cur == start and _face_area(cycle, hes, verts) > 1e-10:
                abs_ids = sorted('@' + feature_id + he_eid[i] for i in cycle)
                # Add surface index to disambiguate queries when multiple surfaces
                # share the same boundary entities (prevents AmbiguousQueryError).
                abs_ids_with_index = abs_ids + [f'surface:{len(surfaces)}']
                query = make_ancestry_query(abs_ids_with_index, 'face')
                surfaces.append({'boundary': [
                    {**hes[i][2], 'start_vertex': hes[i][0], 'end_vertex': hes[i][1]}
                    for i in cycle
                ], 'query': query})

    # Standalone circles (no intersections) → one surface each.
    # Represented as two semicircle arcs so the SVG path is non-degenerate
    # (a single arc from a point back to itself collapses to zero in SVG).
    for eid, e in circles.items():
        if len(_dedup(splits.get(eid, []))) < 2:
            cx, cy, r = e['center'][0], e['center'][1], e['radius']
            # Add surface index to disambiguate when multiple surfaces exist.
            ancestor_ids = ['@' + feature_id + eid, f'surface:{len(surfaces)}']
            query = make_ancestry_query(ancestor_ids, 'face')
            surfaces.append({'boundary': [
                {'kind': 'arc', 'center': [cx, cy], 'radius': r,
                 'angle_start_deg': 0., 'angle_end_deg': 180., 'ccw': True,
                 'start': [cx + r, cy], 'end': [cx - r, cy],
                 'start_vertex': None, 'end_vertex': None},
                {'kind': 'arc', 'center': [cx, cy], 'radius': r,
                 'angle_start_deg': 180., 'angle_end_deg': 360., 'ccw': True,
                 'start': [cx - r, cy], 'end': [cx + r, cy],
                 'start_vertex': None, 'end_vertex': None},
            ], 'query': query})

    return {
        'intersection_points': {
            vid: {'x': verts[vid][0], 'y': verts[vid][1]}
            for vid in intersection_vids
        },
        'vertices': {vid: {'x': v[0], 'y': v[1]} for vid, v in verts.items()},
        'surfaces': surfaces,
    }
