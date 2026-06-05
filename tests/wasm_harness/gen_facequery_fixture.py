"""Generate reference face/edge query strings for the TS faceQuery.ts parity test.

Runs the canonical _build_face_query / _face_tokens / _edge_lineage_tokens over
inputs covering every branch (body vs sketch-face path, face_tokens vs
profile_queries vs classifiers, absent created_by) and writes
`frontend/src/kernel/occ/__fixtures__/faceQueries.json`. The TS test feeds the
same inputs through the port and asserts identical query strings (these strings
feed the resolver, so byte parity matters).

Run: .venv/bin/python tests/wasm_harness/gen_facequery_fixture.py
"""

import json
import os

from oversolved.kernel.geometry_tessellation import (
    _build_face_query,
    _face_tokens,
    _edge_lineage_tokens,
)
from oversolved.kernel.geom_hash import face_geometry_hash, edge_geometry_hash


def _build_cases():
    cases = []

    def case(name, **kw):
        kw.setdefault("profile_queries", None)
        kw.setdefault("face_tokens", None)
        kw.setdefault("classifiers", None)
        result = _build_face_query(
            kw["created_by"], kw["body_id"], kw["face_idx"],
            kw["centroid"], kw["normal"], kw["surface_type"],
            kw["profile_queries"], kw["face_tokens"], kw["classifiers"],
        )
        cases.append({"name": name, "args": kw, "expected": result})

    case("no_created_by", created_by=None, body_id="body_x", face_idx=0,
         centroid=[1.0, 2.0, 3.0], normal=[0.0, 0.0, 1.0], surface_type="flatface")
    case("body_plain", created_by="feat_a", body_id="body_x", face_idx=0,
         centroid=[1.0, 2.0, 3.0], normal=[0.0, 0.0, 1.0], surface_type="flatface")
    case("body_with_face_tokens", created_by="feat_a", body_id="body_x", face_idx=1,
         centroid=[1.5, -2.5, 0.0], normal=[0.0, 0.0, -1.0], surface_type="flatface",
         face_tokens=["@feat_a/e0", "@feat_a/e1"])
    case("body_with_profile_queries", created_by="feat_a", body_id="body_x", face_idx=2,
         centroid=[0.0, 0.0, 5.0], normal=[0.0, 0.0, 1.0], surface_type="flatface",
         profile_queries=["?7;@feat_a"])
    case("body_face_tokens_win_over_profile", created_by="feat_a", body_id="body_x", face_idx=3,
         centroid=[2.0, 2.0, 2.0], normal=[0.5773502691896258] * 3, surface_type="cylinderface",
         face_tokens=["@feat_a/e9"], profile_queries=["?7;@feat_a"])
    case("body_with_classifiers", created_by="feat_a", body_id="body_x", face_idx=4,
         centroid=[10.0, 0.0, 0.0], normal=[1.0, 0.0, 0.0], surface_type="flatface",
         face_tokens=["@feat_a/e0"], classifiers=["cls_xp", "cls_zn"])
    case("sketch_face_no_body", created_by="feat_a", body_id=None, face_idx=7,
         centroid=[1.0, 1.0, 0.0], normal=[0.0, 0.0, 1.0], surface_type="flatface")

    return cases


def _token_cases():
    fl_centroid = [1.0, 2.0, 3.0]
    fl_normal = [0.0, 0.0, 1.0]
    face_key = face_geometry_hash(fl_centroid, fl_normal)
    face_lineage = {face_key: ["@feat_a/e0"]}

    edge = {"kind": "line", "start": [0.0, 0.0, 0.0], "end": [10.0, 0.0, 0.0]}
    edge_key = edge_geometry_hash(edge)
    edge_lineage = {edge_key: ["@feat_a/e3"]}

    bad_edge = {"kind": "arc"}  # missing center/radius -> edge_geometry_hash raises

    return {
        "face_hit": {
            "centroid": fl_centroid, "normal": fl_normal, "face_lineage": face_lineage,
            "expected": _face_tokens(fl_centroid, fl_normal, face_lineage),
        },
        "face_miss": {
            "centroid": [9.0, 9.0, 9.0], "normal": fl_normal, "face_lineage": face_lineage,
            "expected": _face_tokens([9.0, 9.0, 9.0], fl_normal, face_lineage),
        },
        "face_null_lineage": {
            "centroid": fl_centroid, "normal": fl_normal, "face_lineage": None,
            "expected": _face_tokens(fl_centroid, fl_normal, None),
        },
        "edge_hit": {
            "edge": edge, "edge_lineage": edge_lineage,
            "expected": _edge_lineage_tokens(edge, edge_lineage),
        },
        "edge_null_lineage": {
            "edge": edge, "edge_lineage": None,
            "expected": _edge_lineage_tokens(edge, None),
        },
        "edge_hash_raises": {
            "edge": bad_edge, "edge_lineage": edge_lineage,
            "expected": _edge_lineage_tokens(bad_edge, edge_lineage),
        },
    }


def main():
    fixture = {"build": _build_cases(), "tokens": _token_cases()}
    here = os.path.dirname(__file__)
    out_dir = os.path.abspath(
        os.path.join(here, "..", "..", "frontend", "src", "kernel", "occ", "__fixtures__")
    )
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "faceQueries.json")
    with open(out_path, "w") as f:
        json.dump(fixture, f, indent=2)
    print(f"wrote {out_path} ({len(fixture['build'])} build cases)")


if __name__ == "__main__":
    main()
