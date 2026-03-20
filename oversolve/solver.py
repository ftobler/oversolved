import math
import yaml
import jax
import jax.numpy as jnp
import numpy as np
from scipy.optimize import minimize


ENTITY_SIZES = {
    "line_segment": 4,  # x1, y1, x2, y2
    "circle":       3,  # cx, cy, r
    "arc":          5,  # cx, cy, r, a_start_deg, a_end_deg
}


def solve(yaml_str: str) -> dict:
    """Solve all sketch features in a YAML document.

    Returns a nested dict:
        result[feature_id]["initial"][entity_id] -> geometry
        result[feature_id]["solved"][entity_id]  -> geometry

    Geometry per kind:
        line_segment -> {start, end}
        circle       -> {center, radius}
        arc          -> {center, start, end, radius, angle_start, angle_end}
    """
    doc = yaml.safe_load(yaml_str)
    features = doc.get("features", [])

    result = {}
    for feature in features:
        if feature.get("kind") != "sketch":
            continue
        initial, solved = _solve_sketch(feature)
        result[feature["id"]] = {"initial": initial, "solved": solved}
    return result


def _geometry_from_array(x, entities: dict, entity_offsets: dict) -> dict:
    out = {}
    for eid, entity in entities.items():
        off = entity_offsets[eid]
        ep = x[off:off + ENTITY_SIZES[entity["kind"]]]
        kind = entity["kind"]
        if kind == "line_segment":
            out[eid] = {
                "start": (float(ep[0]), float(ep[1])),
                "end":   (float(ep[2]), float(ep[3])),
            }
        elif kind == "circle":
            out[eid] = {
                "center": (float(ep[0]), float(ep[1])),
                "radius": float(ep[2]),
            }
        elif kind == "arc":
            cx, cy, r = float(ep[0]), float(ep[1]), float(ep[2])
            a0, a1 = float(ep[3]), float(ep[4])
            out[eid] = {
                "center":      (cx, cy),
                "radius":      r,
                "angle_start": a0,
                "angle_end":   a1,
                "start": (cx + r * math.cos(math.radians(a0)), cy + r * math.sin(math.radians(a0))),
                "end":   (cx + r * math.cos(math.radians(a1)), cy + r * math.sin(math.radians(a1))),
            }
    return out


def _solve_sketch(feature: dict) -> tuple:
    entities = {e["id"]: e for e in feature["entities"]}
    initial = feature.get("initial", {})
    constraints = feature.get("constraints", [])

    entity_offsets: dict = {}
    params: list = []
    for eid, entity in entities.items():
        entity_offsets[eid] = len(params)
        size = ENTITY_SIZES[entity["kind"]]
        params.extend(initial.get(eid, [0.0] * size))

    x0 = np.array(params, dtype=np.float64)

    def get_params(x, eid):
        off = entity_offsets[eid]
        size = ENTITY_SIZES[entities[eid]["kind"]]
        return x[off:off + size]

    def get_point(x, ref):
        eid = ref["entity"]
        ep = get_params(x, eid)
        kind = entities[eid]["kind"]
        point = ref.get("point", "start")

        if kind == "line_segment":
            return ep[2:4] if point == "end" else ep[0:2]
        elif kind == "circle":
            return ep[0:2]  # only center is addressable
        elif kind == "arc":
            cx, cy, r = ep[0], ep[1], ep[2]
            a_deg = ep[3] if point != "end" else ep[4]
            return jnp.array([cx + r * jnp.cos(jnp.deg2rad(a_deg)),
                               cy + r * jnp.sin(jnp.deg2rad(a_deg))])
        raise ValueError(f"Unknown kind: {kind!r}")

    def residuals(x):
        r = []
        for c in constraints:
            kind = c["kind"]
            if kind == "horizontal":
                ep = get_params(x, c["target"]["entity"])
                r.append(ep[3] - ep[1])
            elif kind == "vertical":
                ep = get_params(x, c["target"]["entity"])
                r.append(ep[2] - ep[0])
            elif kind == "length":
                ep = get_params(x, c["target"]["entity"])
                dx, dy = ep[2] - ep[0], ep[3] - ep[1]
                r.append(jnp.sqrt(dx**2 + dy**2) - c["value"])
            elif kind == "radius":
                ep = get_params(x, c["target"]["entity"])
                r.append(ep[2] - c["value"])  # ep[2] is r for both circle and arc
            elif kind == "coincident":
                pa = get_point(x, c["a"])
                pb = get_point(x, c["b"])
                r.append(pa[0] - pb[0])
                r.append(pa[1] - pb[1])
            elif kind == "perpendicular":
                ea = get_params(x, c["a"]["entity"])
                eb = get_params(x, c["b"]["entity"])
                da = ea[2:4] - ea[0:2]
                db = eb[2:4] - eb[0:2]
                r.append(jnp.dot(da, db))
            elif kind == "angle":
                ea = get_params(x, c["a"]["entity"])
                eb = get_params(x, c["b"]["entity"])
                da = ea[2:4] - ea[0:2]
                db = eb[2:4] - eb[0:2]
                cos_val = jnp.dot(da, db) / (jnp.linalg.norm(da) * jnp.linalg.norm(db))
                r.append(cos_val - jnp.cos(jnp.deg2rad(c["value"])))
            else:
                raise ValueError(f"Unknown constraint kind: {kind!r}")
        return jnp.array(r)

    def loss(x):
        r = residuals(x)
        return jnp.sum(r ** 2)

    loss_and_grad = jax.jit(jax.value_and_grad(loss))

    def scipy_fn(x_np):
        val, grad = loss_and_grad(jnp.array(x_np))
        return float(val), np.array(grad, dtype=np.float64)

    result = minimize(scipy_fn, x0, method="BFGS", jac=True, options={"maxiter": 2000, "gtol": 1e-12})
    x_sol = np.array(result.x)

    return (
        _geometry_from_array(x0, entities, entity_offsets),
        _geometry_from_array(x_sol, entities, entity_offsets),
    )


