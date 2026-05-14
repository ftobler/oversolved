import math


def _geom_point(geom: dict, ref: dict) -> list:
    """Return [x, y] for a constraint point reference {entity, point?} or {external_xy: ...}."""
    if "external_xy" in ref:
        return ref["external_xy"]
    e = geom[ref["entity"]]
    pt = ref.get("point", "start")
    if "start" in e and "end" in e and "radius" in e:  # arc
        if pt == "center":
            return list(e["center"])
        return e["start"] if pt != "end" else e["end"]
    elif "start" in e:  # line
        return e["end"] if pt == "end" else e["start"]
    elif "center" in e:  # circle
        return list(e["center"])
    else:  # point
        return [e["x"], e["y"]]


def _pick_arc_ref(c: dict, geom: dict) -> dict | None:
    """When a constraint uses a/b keys instead of line/arc, return the ref whose
    entity is an arc or circle (has a 'center' key in geom)."""
    for key in ("b", "a"):
        ref = c.get(key)
        if ref and "center" in geom.get(ref.get("entity", ""), {}):
            return ref
    return None


def _pick_line_ref(c: dict, geom: dict) -> dict | None:
    """When a constraint uses a/b keys, return the ref whose entity is a line."""
    for key in ("a", "b"):
        ref = c.get(key)
        if ref and "start" in geom.get(ref.get("entity", ""), {}):
            return ref
    return None


def _constraint_render(c: dict, geom: dict) -> dict:
    """Compute geometric render data for a single constraint using solved geometry."""
    kind = c["kind"]

    if kind == "horizontal":
        if "a" in c:
            pa = _geom_point(geom, c["a"])
            pb = _geom_point(geom, c["b"])
            at = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]
            eid = c["a"].get("entity") or c["b"].get("entity") or ""
            return {"kind": "symbol_h", "at": at, "entity": eid}
        eid = c["target"].get("entity", "")
        if not eid:
            return {}
        e = geom[eid]
        at = [(e["start"][0] + e["end"][0]) / 2, (e["start"][1] + e["end"][1]) / 2]
        return {"kind": "symbol_h", "at": at, "entity": eid}

    elif kind == "vertical":
        if "a" in c:
            pa = _geom_point(geom, c["a"])
            pb = _geom_point(geom, c["b"])
            at = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]
            eid = c["a"].get("entity") or c["b"].get("entity") or ""
            return {"kind": "symbol_v", "at": at, "entity": eid}
        eid = c["target"].get("entity", "")
        if not eid:
            return {}
        e = geom[eid]
        at = [(e["start"][0] + e["end"][0]) / 2, (e["start"][1] + e["end"][1]) / 2]
        return {"kind": "symbol_v", "at": at, "entity": eid}

    elif kind == "length":
        eid = c["target"]["entity"]
        e = geom[eid]
        dx = e["end"][0] - e["start"][0]
        dy = e["end"][1] - e["start"][1]
        n = math.hypot(dx, dy)
        # Degenerate (zero-length) line produces p1 == p2 render.
        normal = [-dy / n, dx / n] if n > 0 else [0.0, 1.0]
        return {
            "kind": "dim_linear",
            "p1": e["start"],
            "p2": e["end"],
            "value": c["value"],
            "normal": normal,
            "entity": eid,
        }

    elif kind == "radius":
        eid = c["target"]["entity"]
        e = geom[eid]
        center = e["center"]
        edge = (
            e["start"]
            if "start" in e
            else [e["center"][0] + e["radius"], e["center"][1]]
        )
        return {
            "kind": "dim_radius",
            "p1": center,
            "p2": edge,
            "value": c["value"],
            "entity": eid,
        }

    elif kind == "diameter":
        eid = c["target"]["entity"]
        e = geom[eid]
        cx, cy, r = e["center"][0], e["center"][1], e["radius"]
        return {
            "kind": "dim_diameter",
            "p1": [cx - r, cy],
            "p2": [cx + r, cy],
            "value": c["value"],
            "entity": eid,
        }

    elif kind == "line_distance":
        eid_a = c["a"]["entity"]
        ea = geom[eid_a]
        dx = ea["end"][0] - ea["start"][0]
        dy = ea["end"][1] - ea["start"][1]
        n = math.hypot(dx, dy)
        nx, ny = (-dy / n, dx / n) if n > 0 else (0.0, 1.0)
        pb = _geom_point(geom, c["b"])
        t = (pb[0] - ea["start"][0]) * nx + (pb[1] - ea["start"][1]) * ny
        foot = [pb[0] - t * nx, pb[1] - t * ny]
        return {
            "kind": "dim_linear",
            "p1": foot,
            "p2": list(pb),
            "value": c["value"],
            "normal": [nx, ny],
            "entity": eid_a,
        }

    elif kind == "coincident":
        a_eid = c["a"]["entity"]
        ea = geom[a_eid]
        if (
            "point" not in c["a"]
            and "start" in ea
            and "start" in geom.get(c["b"]["entity"], {})
        ):
            at = [
                (ea["start"][0] + ea["end"][0]) / 2,
                (ea["start"][1] + ea["end"][1]) / 2,
            ]
        else:
            at = _geom_point(geom, c["a"])
        return {"kind": "symbol_coincident", "at": at, "entity": a_eid}

    elif kind == "normal":
        ea_id = c["a"]["entity"]
        eb_id = c["b"]["entity"]
        ea = geom[ea_id]
        eb = geom[eb_id]
        if "center" in eb:
            pt = (
                eb["start"]
                if "start" in eb and c["b"].get("point", "start") != "end"
                else list(eb["center"])
            )
            return {"kind": "symbol_normal", "at": pt, "entity": eb_id}
        elif "center" in ea:
            pt = (
                ea["start"]
                if "start" in ea and c["a"].get("point", "start") != "end"
                else list(ea["center"])
            )
            return {"kind": "symbol_normal", "at": pt, "entity": ea_id}
        else:
            return {"kind": "symbol_normal", "at": ea["end"], "entity": ea_id}

    elif kind == "parallel":
        eid = c["a"]["entity"]
        ea = geom[eid]
        at = [(ea["start"][0] + ea["end"][0]) / 2, (ea["start"][1] + ea["end"][1]) / 2]
        return {"kind": "symbol_parallel", "at": at, "entity": eid}

    elif kind == "angle":
        eid = c["a"]["entity"]
        ea, eb = geom[eid], geom[c["b"]["entity"]]
        return {
            "kind": "dim_angle",
            "p1": ea["start"],
            "p2": ea["end"],
            "p3": eb["start"],
            "p4": eb["end"],
            "value": c["value"],
            "entity": eid,
        }

    elif kind == "tangent":
        arc_ref = c.get("arc") or (_pick_arc_ref(c, geom))
        if not arc_ref:
            return {"kind": "unknown"}
        eid = arc_ref["entity"]
        arc = geom[eid]
        if "start" in arc:
            pt = arc["start"] if arc_ref.get("point", "start") != "end" else arc["end"]
        elif "center" in arc:
            line_ref = c.get("line") or _pick_line_ref(c, geom)
            if line_ref:
                line = geom[line_ref["entity"]]
                cx, cy = arc["center"]
                x0, y0 = line["start"]
                x1, y1 = line["end"]
                dx, dy = x1 - x0, y1 - y0
                seg_len2 = dx * dx + dy * dy
                if seg_len2 > 1e-12:
                    t = ((cx - x0) * dx + (cy - y0) * dy) / seg_len2
                    t = max(0.0, min(1.0, t))
                    pt = [x0 + t * dx, y0 + t * dy]
                else:
                    pt = [x0, y0]
            else:
                pt = list(arc["center"])
        else:
            pt = list(arc["center"])
        return {"kind": "symbol_tangent", "at": pt, "entity": eid}

    elif kind == "equal_length":
        eid = c["a"]["entity"]
        ea, eb = geom[eid], geom[c["b"]["entity"]]
        at_a = [
            (ea["start"][0] + ea["end"][0]) / 2,
            (ea["start"][1] + ea["end"][1]) / 2,
        ]
        at_b = [
            (eb["start"][0] + eb["end"][0]) / 2,
            (eb["start"][1] + eb["end"][1]) / 2,
        ]
        return {"kind": "symbol_equal", "at_a": at_a, "at_b": at_b, "entity": eid}

    elif kind == "point_distance":
        pa = _geom_point(geom, c["a"])
        pb = _geom_point(geom, c["b"])
        dx, dy = pb[0] - pa[0], pb[1] - pa[1]
        n = math.hypot(dx, dy)
        normal = [-dy / n, dx / n] if n > 0 else [0.0, 1.0]
        eid = c["a"].get("entity") or c["b"].get("entity") or ""
        return {
            "kind": "dim_linear",
            "p1": pa,
            "p2": pb,
            "value": c["value"],
            "normal": normal,
            "entity": eid,
        }

    elif kind == "midpoint":
        if "line" in c:
            eid = c["line"]["entity"]
            e = geom[eid]
            at = [(e["start"][0] + e["end"][0]) / 2, (e["start"][1] + e["end"][1]) / 2]
        else:
            eid = c["point_a"]["entity"]
            pa = _geom_point(geom, c["point_a"])
            pb = _geom_point(geom, c["point_b"])
            at = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]
        return {
            "kind": "symbol_midpoint",
            "at": at,
            "axis": c.get("axis", "both"),
            "entity": eid,
        }

    elif kind == "concentric":
        eid = c["a"]["entity"]
        e = geom[eid]
        center = e["center"] if "center" in e else [e["x"], e["y"]]
        return {"kind": "symbol_concentric", "at": center, "entity": eid}

    elif kind == "fixed":
        eid = c["target"]["entity"]
        at = _geom_point(geom, c["target"])
        return {
            "kind": "symbol_fixed",
            "at": at,
            "x": c.get("x", at[0]),
            "y": c.get("y", at[1]),
            "entity": eid,
        }

    return {"kind": "unknown"}
