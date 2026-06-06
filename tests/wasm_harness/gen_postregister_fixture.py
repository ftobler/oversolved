"""Generate reference repo state for the TS postRegister.ts parity test.

Runs the canonical `_post_register` over a battery of solved-sketch feature
results (rectangle + point, circle, arc wedge, rectangle on a non-trivial plane)
and writes `frontend/src/kernel/features/__fixtures__/postRegister.json`. The TS
test feeds each identical (feature, feature_result) pair through the port and
asserts the same slash registry (`@feature/entity/sub`), `_pt_` frame, and
topology surface/edge/vertex ancestral payloads, coordinates within a tight
tolerance.

This is the direct parity gate for the half of `_post_register` the full-doc
harness barely exercises: solved-entity slash registration plus topology
surface/edge/vertex ancestry (the layer every pick/dimension resolves through).

Entity ids are non-numeric so Python dict order and JS object key order agree.

Run: .venv/bin/python tests/wasm_harness/gen_postregister_fixture.py
"""

import json
import math
import os

from oversolved.kernel.query import _init_global_repo
from oversolved.kernel.solver_registry import _post_register, _plane_transform
from oversolved.kernel.solver_constants import _BUILTIN_PLANES
from oversolved.kernel.topology import detect_topology


def _rich_line(x0, y0, x1, y1):
    return {"start": [x0, y0], "end": [x1, y1]}


def _rich_circle(cx, cy, r):
    return {"center": [cx, cy], "radius": r}


def _rich_arc(cx, cy, r, a0, a1):
    return {
        "center": [cx, cy],
        "radius": r,
        "angle_start": a0,
        "angle_end": a1,
        "start": [cx + r * math.cos(math.radians(a0)), cy + r * math.sin(math.radians(a0))],
        "end": [cx + r * math.cos(math.radians(a1)), cy + r * math.sin(math.radians(a1))],
    }


# Flat solver-output params per entity kind (mirrors _geometry_from_array's inverse).
def _flat(kind, rich):
    if kind == "line":
        return list(rich["start"]) + list(rich["end"])
    if kind == "circle":
        return list(rich["center"]) + [rich["radius"]]
    if kind == "arc":
        return [rich["center"][0], rich["center"][1], rich["radius"], rich["angle_start"], rich["angle_end"]]
    if kind == "point":
        return list(rich["xy"])
    raise ValueError(kind)


def _case(feature_id, plane_name, entities):
    """entities: list of (eid, kind, rich_geom_or_xy)."""
    rich = {}
    flat = {}
    ent_specs = []
    for eid, kind, geom in entities:
        ent_specs.append({"id": eid, "kind": kind})
        if kind == "point":
            flat[eid] = list(geom)  # geom is the xy pair
        else:
            rich[eid] = geom
            flat[eid] = _flat(kind, geom)
    plane = _BUILTIN_PLANES[plane_name]
    feature = {
        "id": feature_id,
        "kind": "sketch",
        "plane": "@" + plane_name,
        "entities": ent_specs,
    }
    feature_result = {
        "status": "ok",
        "geometry": flat,
        "topology": detect_topology(rich, feature_id),
        "plane_transform": _plane_transform(plane),
    }
    return feature, feature_result


def _cases():
    return {
        "square_point_front": _case(
            "sk1", "builtin_plane_front",
            [
                ("ln_b", "line", _rich_line(0, 0, 10, 0)),
                ("ln_r", "line", _rich_line(10, 0, 10, 10)),
                ("ln_t", "line", _rich_line(10, 10, 0, 10)),
                ("ln_l", "line", _rich_line(0, 10, 0, 0)),
                ("pt_c", "point", [5, 5]),
            ],
        ),
        "circle_front": _case(
            "skC", "builtin_plane_front",
            [("ci", "circle", _rich_circle(2, 3, 5))],
        ),
        "arc_wedge_front": _case(
            "skP", "builtin_plane_front",
            [
                ("ln_a", "line", _rich_line(0, 0, 10, 0)),
                ("arc", "arc", _rich_arc(0, 0, 10, 0, 90)),
                ("ln_b", "line", _rich_line(0, 10, 0, 0)),
            ],
        ),
        # Rectangle on the top plane: world coords differ from sketch coords, so
        # sketch_to_world_2d (and the topology world origins) are exercised.
        "square_top": _case(
            "skT", "builtin_plane_top",
            [
                ("ln_b", "line", _rich_line(0, 0, 6, 0)),
                ("ln_r", "line", _rich_line(6, 0, 6, 4)),
                ("ln_t", "line", _rich_line(6, 4, 0, 4)),
                ("ln_l", "line", _rich_line(0, 4, 0, 0)),
                ("pt_c", "point", [3, 2]),
            ],
        ),
    }


def _dump_repo(repo, feature_id):
    """Snapshot the registration-relevant repo state for cross-language compare."""
    slash = {
        k: v for k, v in repo.elements.items()
        if isinstance(k, str) and "/" in k and k.split("/")[0] == feature_id
    }
    pt = repo.elements.get("_pt_" + feature_id)
    ancestral = []
    for key, eids in repo.ancestral.items():
        ancestral.append({
            "ids": sorted(key),
            "payloads": [repo.elements.get(eid) for eid in eids],
        })
    # Sort by serialized key for deterministic JSON (the TS test compares as a
    # set, but a stable dump keeps regeneration diffs clean).
    ancestral.sort(key=lambda e: json.dumps(e["ids"], sort_keys=True))
    return {"slash": slash, "pt": pt, "ancestral": ancestral}


def main():
    fixture = {}
    for name, (feature, feature_result) in _cases().items():
        repo = _init_global_repo()
        _post_register(repo, feature["id"], feature, feature_result)
        fixture[name] = {
            "feature": feature,
            "feature_result": feature_result,
            "expected": _dump_repo(repo, feature["id"]),
        }
    here = os.path.dirname(__file__)
    out_dir = os.path.abspath(
        os.path.join(here, "..", "..", "frontend", "src", "kernel", "features", "__fixtures__")
    )
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "postRegister.json")
    with open(out_path, "w") as f:
        json.dump(fixture, f, indent=2)
    summary = {
        k: (len(v["expected"]["slash"]), len(v["expected"]["ancestral"]))
        for k, v in fixture.items()
    }
    print(f"wrote {out_path}; (slash, ancestral): {summary}")


if __name__ == "__main__":
    main()
