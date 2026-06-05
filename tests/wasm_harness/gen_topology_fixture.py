"""Generate reference topology for the TS topology.ts dual-run parity test.

Runs the canonical `detect_topology` over a battery of solved-sketch geometries
(polygons, circles, concentric annuli, line-divided regions, arcs, circle
intersections) and writes `frontend/src/kernel/occ/__fixtures__/topology.json`.
The TS test runs the port over the same inputs and asserts identical structure
and identity-bearing query strings, with coordinates compared within a tight
tolerance (cross-language transcendental last-bit differences are expected).

Entity ids are deliberately non-numeric so both Python dict order and JS object
key order agree (the real kernel mints non-numeric entity ids).

Run: .venv/bin/python tests/wasm_harness/gen_topology_fixture.py
"""

import json
import os

from oversolved.kernel.topology import detect_topology


def _line(x0, y0, x1, y1, construction=False):
    e = {"start": [x0, y0], "end": [x1, y1]}
    if construction:
        e["construction"] = True
    return e


def _circle(cx, cy, r):
    return {"center": [cx, cy], "radius": r}


def _arc(cx, cy, r, a0_deg, a1_deg):
    import math

    return {
        "center": [cx, cy],
        "radius": r,
        "angle_start": a0_deg,
        "angle_end": a1_deg,
        "start": [cx + r * math.cos(math.radians(a0_deg)), cy + r * math.sin(math.radians(a0_deg))],
        "end": [cx + r * math.cos(math.radians(a1_deg)), cy + r * math.sin(math.radians(a1_deg))],
    }


def _cases():
    return {
        "square": {
            "feature_id": "sk1",
            "geometry": {
                "ln_b": _line(0, 0, 10, 0),
                "ln_r": _line(10, 0, 10, 10),
                "ln_t": _line(10, 10, 0, 10),
                "ln_l": _line(0, 10, 0, 0),
            },
        },
        "square_with_construction": {
            "feature_id": "sk1",
            "geometry": {
                "ln_b": _line(0, 0, 10, 0),
                "ln_r": _line(10, 0, 10, 10),
                "ln_t": _line(10, 10, 0, 10),
                "ln_l": _line(0, 10, 0, 0),
                "ln_diag_constr": _line(0, 0, 10, 10, construction=True),
            },
        },
        "triangle": {
            "feature_id": "skT",
            "geometry": {
                "ln_a": _line(0, 0, 8, 0),
                "ln_b": _line(8, 0, 4, 6),
                "ln_c": _line(4, 6, 0, 0),
            },
        },
        "square_diagonal_split": {
            "feature_id": "skD",
            "geometry": {
                "ln_b": _line(0, 0, 10, 0),
                "ln_r": _line(10, 0, 10, 10),
                "ln_t": _line(10, 10, 0, 10),
                "ln_l": _line(0, 10, 0, 0),
                "ln_diag": _line(0, 0, 10, 10),
            },
        },
        "standalone_circle": {
            "feature_id": "skC",
            "geometry": {"ci": _circle(0, 0, 5)},
        },
        "concentric_annulus": {
            "feature_id": "skA",
            "geometry": {
                "ci_out": _circle(0, 0, 10),
                "ci_in": _circle(0, 0, 4),
            },
        },
        "two_circles_intersecting": {
            "feature_id": "skX",
            "geometry": {
                "ci_l": _circle(0, 0, 6),
                "ci_r": _circle(8, 0, 6),
            },
        },
        "line_through_circle": {
            "feature_id": "skLC",
            "geometry": {
                "ci": _circle(0, 0, 5),
                "ln": _line(-10, 0, 10, 0),
            },
        },
        "pie_wedge": {
            "feature_id": "skP",
            "geometry": {
                "ln_a": _line(0, 0, 10, 0),
                "arc": _arc(0, 0, 10, 0, 90),
                "ln_b": _line(0, 10, 0, 0),
            },
        },
    }


def main():
    cases = _cases()
    fixture = {
        name: {
            "feature_id": c["feature_id"],
            "geometry": c["geometry"],
            "expected": detect_topology(c["geometry"], c["feature_id"]),
        }
        for name, c in cases.items()
    }
    here = os.path.dirname(__file__)
    out_dir = os.path.abspath(
        os.path.join(here, "..", "..", "frontend", "src", "kernel", "occ", "__fixtures__")
    )
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "topology.json")
    with open(out_path, "w") as f:
        json.dump(fixture, f, indent=2)
    summary = {
        k: (len(v["expected"]["surfaces"]), len(v["expected"]["edges"]), len(v["expected"]["vertices"]))
        for k, v in fixture.items()
    }
    print(f"wrote {out_path}; (surfaces, edges, vertices): {summary}")


if __name__ == "__main__":
    main()
