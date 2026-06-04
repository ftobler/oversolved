from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable
import numpy as np
from oversolved.kernel.solver_constants import ENTITY_SIZES

logger = logging.getLogger(__name__)

__all__ = ["_build_residuals_fn", "_CONSTRAINT_HANDLERS", "ResidualContext"]


@dataclass
class ResidualContext:
    entities: dict[str, dict]
    entity_offsets: dict[str, int]
    x0: np.ndarray
    radius_dir: Callable
    line_circle_coincident: dict


# ─── Constraint residual handlers ───

def _residual_horizontal(
    c: dict, x: np.ndarray,
    get_params: Callable, get_point: Callable,
    ctx: ResidualContext,
) -> list:
    if "a" in c:
        pa = get_point(x, c["a"])
        pb = get_point(x, c["b"])
        return [float(pa[1] - pb[1])]
    ep = get_params(x, c["target"]["entity"])
    return [float(ep[3] - ep[1])]


def _residual_vertical(
    c: dict, x: np.ndarray,
    get_params: Callable, get_point: Callable,
    ctx: ResidualContext,
) -> list:
    if "a" in c:
        pa = get_point(x, c["a"])
        pb = get_point(x, c["b"])
        return [float(pa[0] - pb[0])]
    ep = get_params(x, c["target"]["entity"])
    return [float(ep[2] - ep[0])]


def _residual_length(
    c: dict, x: np.ndarray,
    get_params: Callable, get_point: Callable,
    ctx: ResidualContext,
) -> list:
    ep = get_params(x, c["target"]["entity"])
    dx, dy = ep[2] - ep[0], ep[3] - ep[1]
    return [float(np.sqrt(dx**2 + dy**2) - c["value"])]


def _residual_radius(
    c: dict, x: np.ndarray,
    get_params: Callable, get_point: Callable,
    ctx: ResidualContext,
) -> list:
    ep = get_params(x, c["target"]["entity"])
    return [float(ep[2] - c["value"])]


def _residual_diameter(
    c: dict, x: np.ndarray,
    get_params: Callable, get_point: Callable,
    ctx: ResidualContext,
) -> list:
    ep = get_params(x, c["target"]["entity"])
    return [float(2 * ep[2] - c["value"])]


def _residual_line_distance(
    c: dict, x: np.ndarray,
    get_params: Callable, get_point: Callable,
    ctx: ResidualContext,
) -> list:
    if c["a"]["entity"] == c["b"]["entity"]:
        raise ValueError(
            f"line_distance constraint '{c['id']}': "
            "a and b cannot reference the same entity"
        )
    ep_a = get_params(x, c["a"]["entity"])
    pb = get_point(x, c["b"])
    dx, dy = ep_a[2] - ep_a[0], ep_a[3] - ep_a[1]
    n = np.sqrt(dx**2 + dy**2)
    nx, ny = (-dy / n, dx / n) if n > 0 else (0.0, 1.0)
    vx = pb[0] - ep_a[0]
    vy = pb[1] - ep_a[1]
    return [float(vx * nx + vy * ny - c["value"])]


def _residual_coincident(
    c: dict, x: np.ndarray,
    get_params: Callable, get_point: Callable,
    ctx: ResidualContext,
) -> list:
    a_ref = c["a"]
    b_ref = c["b"]
    a_external = "external_xy" in a_ref
    b_external = "external_xy" in b_ref
    a_eid: str | None = None if a_external else a_ref["entity"]
    b_eid: str | None = None if b_external else b_ref["entity"]
    a_kind = None if a_external else ctx.entities[a_eid]["kind"]  # type: ignore[index]
    b_kind = None if b_external else ctx.entities[b_eid]["kind"]  # type: ignore[index]
    r = []
    if (
        not a_external
        and not b_external
        and "point" not in a_ref
        and "point" not in b_ref
        and a_kind == "line"
        and b_kind == "line"
    ):
        ea = get_params(x, a_eid)
        eb = get_params(x, b_eid)
        da = ea[2:4] - ea[0:2]
        db = eb[2:4] - eb[0:2]
        r.append(float(da[0] * db[1] - da[1] * db[0]))
        n = np.sqrt(da[0] ** 2 + da[1] ** 2)
        nx, ny = (-da[1] / n, da[0] / n) if n > 0 else (0.0, 1.0)
        r.append(float((eb[0] - ea[0]) * nx + (eb[1] - ea[1]) * ny))
    elif not b_external and "point" not in b_ref and b_kind == "line":
        pa = get_point(x, a_ref)
        ep_b = get_params(x, b_eid)
        dx, dy = ep_b[2] - ep_b[0], ep_b[3] - ep_b[1]
        n = np.sqrt(dx**2 + dy**2)
        nx, ny = (-dy / n, dx / n) if n > 0 else (0.0, 1.0)
        r.append(float((pa[0] - ep_b[0]) * nx + (pa[1] - ep_b[1]) * ny))
    elif (
        not b_external
        and "point" not in b_ref
        and b_kind in ("circle", "arc")
    ):
        pa = get_point(x, a_ref)
        ep_b = get_params(x, b_eid)
        dist = np.sqrt((pa[0] - ep_b[0]) ** 2 + (pa[1] - ep_b[1]) ** 2)
        r.append(float(dist - ep_b[2]))
    else:
        pa = get_point(x, a_ref)
        pb = get_point(x, b_ref)
        r.append(float(pa[0] - pb[0]))
        r.append(float(pa[1] - pb[1]))
    return r


def _residual_normal(
    c: dict, x: np.ndarray,
    get_params: Callable, get_point: Callable,
    ctx: ResidualContext,
) -> list:
    ea_id = c["a"]["entity"]
    eb_id = c["b"]["entity"]
    ea_kind = ctx.entities[ea_id]["kind"]
    eb_kind = ctx.entities[eb_id]["kind"]
    if ea_kind == "line" and eb_kind == "line":
        ea = get_params(x, ea_id)
        eb = get_params(x, eb_id)
        da = ea[2:4] - ea[0:2]
        db = eb[2:4] - eb[0:2]
        return [float(np.dot(da, db))]
    line_ref = c["a"] if ea_kind == "line" else c["b"]
    arc_ref = c["b"] if ea_kind == "line" else c["a"]
    line_ep = get_params(x, line_ref["entity"])
    line_dir = line_ep[2:4] - line_ep[0:2]
    contact = line_ep[2:4]
    radius_dir = ctx.radius_dir(x, arc_ref["entity"], arc_ref, contact)
    return [float(line_dir[0] * radius_dir[1] - line_dir[1] * radius_dir[0])]


def _residual_parallel(
    c: dict, x: np.ndarray,
    get_params: Callable, get_point: Callable,
    ctx: ResidualContext,
) -> list:
    ea = get_params(x, c["a"]["entity"])
    eb = get_params(x, c["b"]["entity"])
    da = ea[2:4] - ea[0:2]
    db = eb[2:4] - eb[0:2]
    return [float(da[0] * db[1] - da[1] * db[0])]


def _residual_angle(
    c: dict, x: np.ndarray,
    get_params: Callable, get_point: Callable,
    ctx: ResidualContext,
) -> list:
    ea = get_params(x, c["a"]["entity"])
    eb = get_params(x, c["b"]["entity"])
    da = ea[2:4] - ea[0:2]
    db = eb[2:4] - eb[0:2]
    dot = da[0] * db[0] + da[1] * db[1]
    cross = da[0] * db[1] - da[1] * db[0]
    angle = np.arctan2(np.abs(cross), dot)
    return [float(angle - np.radians(c["value"]))]


def _residual_tangent(
    c: dict, x: np.ndarray,
    get_params: Callable, get_point: Callable,
    ctx: ResidualContext,
) -> list:
    if "line" in c and "arc" in c:
        line_ref, arc_ref = c["line"], c["arc"]
    else:
        ea_id = c["a"]["entity"]
        if ctx.entities[ea_id]["kind"] == "line":
            line_ref, arc_ref = c["a"], c["b"]
        else:
            line_ref, arc_ref = c["b"], c["a"]
    line_ep = get_params(x, line_ref["entity"])
    arc_ep = get_params(x, arc_ref["entity"])
    line_dir = line_ep[2:4] - line_ep[0:2]
    norm = np.sqrt(np.dot(line_dir, line_dir))
    norm = max(norm, 1e-12)
    line_dir = line_dir / norm
    r = []
    if ctx.entities[arc_ref["entity"]]["kind"] == "circle":
        line_eid = line_ref["entity"]
        arc_eid = arc_ref["entity"]
        if (line_eid, arc_eid) in ctx.line_circle_coincident:
            pinned_pt = ctx.line_circle_coincident[(line_eid, arc_eid)]
            contact = line_ep[0:2] if pinned_pt == "start" else line_ep[2:4]
            radius_dir = ctx.radius_dir(x, arc_eid, arc_ref, contact)
            r.append(float(np.dot(line_dir, radius_dir)))
        else:
            contact = line_ep[2:4]
            radius_dir = ctx.radius_dir(x, arc_ref["entity"], arc_ref, contact)
            r.append(float(np.dot(line_dir, radius_dir)))
            dist = np.sqrt(
                (contact[0] - arc_ep[0]) ** 2
                + (contact[1] - arc_ep[1]) ** 2
            )
            r.append(float(dist - arc_ep[2]))
    else:
        contact = line_ep[2:4]
        radius_dir = ctx.radius_dir(x, arc_ref["entity"], arc_ref, contact)
        r.append(float(np.dot(line_dir, radius_dir)))
    return r


def _residual_equal_length(
    c: dict, x: np.ndarray,
    get_params: Callable, get_point: Callable,
    ctx: ResidualContext,
) -> list:
    ea = get_params(x, c["a"]["entity"])
    eb = get_params(x, c["b"]["entity"])
    len_a = np.sqrt((ea[2] - ea[0]) ** 2 + (ea[3] - ea[1]) ** 2)
    len_b = np.sqrt((eb[2] - eb[0]) ** 2 + (eb[3] - eb[1]) ** 2)
    return [float(len_a - len_b)]


def _residual_point_distance(
    c: dict, x: np.ndarray,
    get_params: Callable, get_point: Callable,
    ctx: ResidualContext,
) -> list:
    pa = get_point(x, c["a"])
    pb = get_point(x, c["b"])
    dist = np.sqrt((pb[0] - pa[0]) ** 2 + (pb[1] - pa[1]) ** 2)
    return [float(dist - c["value"])]


def _residual_midpoint(
    c: dict, x: np.ndarray,
    get_params: Callable, get_point: Callable,
    ctx: ResidualContext,
) -> list:
    if "line" in c:
        ep = get_params(x, c["line"]["entity"])
        mid = np.array([(ep[0] + ep[2]) / 2, (ep[1] + ep[3]) / 2])
    else:
        pa = get_point(x, c["point_a"])
        pb = get_point(x, c["point_b"])
        mid = (pa + pb) / 2
    pt = get_point(x, c["point"])
    axis = c.get("axis", "both")
    r = []
    if axis in ("x", "both"):
        r.append(float(pt[0] - mid[0]))
    if axis in ("y", "both"):
        r.append(float(pt[1] - mid[1]))
    return r


def _residual_concentric(
    c: dict, x: np.ndarray,
    get_params: Callable, get_point: Callable,
    ctx: ResidualContext,
) -> list:
    ea = get_params(x, c["a"]["entity"])
    eb = get_params(x, c["b"]["entity"])
    return [float(ea[0] - eb[0]), float(ea[1] - eb[1])]


def _residual_fixed(
    c: dict, x: np.ndarray,
    get_params: Callable, get_point: Callable,
    ctx: ResidualContext,
) -> list:
    eid = c["target"]["entity"]
    has_point = "point" in c["target"]
    has_xy = "x" in c and "y" in c
    if has_point or has_xy:
        pt = get_point(x, c["target"])
        fix_x = c.get("x", float(get_point(ctx.x0, c["target"])[0]))
        fix_y = c.get("y", float(get_point(ctx.x0, c["target"])[1]))
        return [float(pt[0] - fix_x), float(pt[1] - fix_y)]
    off = ctx.entity_offsets[eid]
    size = ENTITY_SIZES[ctx.entities[eid]["kind"]]
    r = []
    for i in range(size):
        r.append(float(x[off + i] - ctx.x0[off + i]))
    return r


_CONSTRAINT_HANDLERS: dict[str, Callable] = {
    "horizontal": _residual_horizontal,
    "vertical": _residual_vertical,
    "length": _residual_length,
    "radius": _residual_radius,
    "diameter": _residual_diameter,
    "line_distance": _residual_line_distance,
    "coincident": _residual_coincident,
    "normal": _residual_normal,
    "parallel": _residual_parallel,
    "angle": _residual_angle,
    "tangent": _residual_tangent,
    "equal_length": _residual_equal_length,
    "point_distance": _residual_point_distance,
    "midpoint": _residual_midpoint,
    "concentric": _residual_concentric,
    "fixed": _residual_fixed,
}


def _build_residuals_fn(
    constraints: list[dict],
    entities: dict[str, dict],
    entity_offsets: dict[str, int],
    x0: np.ndarray,
) -> tuple[Callable, dict]:
    """Build a residuals function for least_squares optimization.

    Returns (residuals_func, line_circle_coincident) where residuals_func
    takes a parameter vector x and returns the residual vector.
    """
    def get_params(x: np.ndarray, eid: str) -> np.ndarray:
        off = entity_offsets[eid]
        size = ENTITY_SIZES[entities[eid]["kind"]]
        return x[off: off + size]

    def get_point(x: np.ndarray, ref: dict) -> np.ndarray:
        if "external_xy" in ref:
            return np.array(ref["external_xy"], dtype=np.float64)
        eid = ref["entity"]
        ep = get_params(x, eid)
        kind = entities[eid]["kind"]
        point = ref.get("point", "start")
        if kind == "line":
            return ep[2:4] if point == "end" else ep[0:2]
        elif kind == "circle":
            return ep[0:2]
        elif kind == "arc":
            if point == "center":
                return ep[0:2]
            cx, cy, r = ep[0], ep[1], ep[2]
            a_deg = ep[3] if point != "end" else ep[4]
            return np.array(
                [cx + r * np.cos(np.radians(a_deg)), cy + r * np.sin(np.radians(a_deg))]
            )
        elif kind == "point":
            return ep[0:2]
        raise ValueError(f"Unknown kind: {kind!r}")

    def _radius_dir(x: np.ndarray, arc_eid: str, arc_ref: dict, contact_ep: np.ndarray) -> np.ndarray:
        ep = get_params(x, arc_eid)
        if entities[arc_eid]["kind"] == "circle":
            rv = contact_ep - ep[0:2]
            rn = np.linalg.norm(rv)
            return rv / rn if rn > 1e-10 else np.zeros(2)
        arc_pt = arc_ref.get("point", "start")
        a_deg = ep[3] if arc_pt != "end" else ep[4]
        return np.array([np.cos(np.radians(a_deg)), np.sin(np.radians(a_deg))])

    line_circle_coincident: dict = {}
    for _c in constraints:
        if _c.get("kind") == "coincident" and "point" in _c.get("a", {}):
            _a, _b = _c["a"], _c["b"]
            _a_eid = _a.get("entity")
            _b_eid = _b.get("entity")
            if (
                _a_eid
                and _b_eid
                and entities.get(_a_eid, {}).get("kind") == "line"
                and entities.get(_b_eid, {}).get("kind") == "circle"
                and "point" not in _b
            ):
                line_circle_coincident[(_a_eid, _b_eid)] = _a.get("point", "start")

    ctx = ResidualContext(
        entities=entities,
        entity_offsets=entity_offsets,
        x0=x0,
        radius_dir=_radius_dir,
        line_circle_coincident=line_circle_coincident,
    )

    def residuals(x: np.ndarray, clist: list | None = None) -> np.ndarray:
        r: list = []
        for c in clist if clist is not None else constraints:
            kind = c["kind"]
            handler = _CONSTRAINT_HANDLERS.get(kind)
            if handler is None:
                raise ValueError(f"Unknown constraint kind: {kind!r}")
            r.extend(handler(c, x, get_params, get_point, ctx))
        return np.array(r) if r else np.zeros(0)

    return residuals, line_circle_coincident
