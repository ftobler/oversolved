"""Generate reference fillet/chamfer-lineage output for the TS edgeModifier gate (phase 2f).

Builds a 10-cube, assigns a distinct lineage token to every face and edge (keyed
by geometry hash), then runs apply_fillet_with_lineage / apply_chamfer_with_lineage
on a single edge (identified by its geometry hash so the TS side can pick the same
edge without relying on enumeration order). Records the input box + target edge
hash + radius/distance + input lineage, then the output volume, the new face/edge
lineage maps, and the BrepDiff sub-shape counts. Writes
`frontend/src/kernel/occ/__fixtures__/fillet.json`. The gated test
(edgeModifierReal.test.ts) replays and asserts volume + diff counts + lineage
(token-multiset, since the curved fillet face's geom-hash key diverges across OCC
builds).

Run: .venv/bin/python tests/wasm_harness/gen_fillet_fixture.py
"""

import json
import os

from oversolved.kernel.cadquery_ops import _ensure_cq, _ensure_occ, _compute_face_centroid, _compute_face_normal
from oversolved.kernel.geometry_tessellation import edge_to_geom_dict
from oversolved.kernel.geom_hash import edge_geometry_hash, face_geometry_hash
from oversolved.kernel.geometry_features import apply_fillet_with_lineage, apply_chamfer_with_lineage
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp


def _volume(solid) -> float:
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(_ensure_occ(solid), props, True, False, False)
    return props.Mass()


def _box(dx, dy, dz):
    return BRepPrimAPI_MakeBox(dx, dy, dz).Shape()


def _face_lineage(box):
    cq = _ensure_cq(box)
    out = {}
    for i, f in enumerate(cq.Faces()):
        gh = face_geometry_hash(list(_compute_face_centroid(f)), list(_compute_face_normal(f)))
        out[gh] = [f"@face_{i}"]
    return out


def _edge_index(box):
    """Unique edges with their geom hash, in enumeration order (deduped by IsEqual)."""
    cq = _ensure_cq(box)
    seen = []
    edges = []
    for e in cq.Edges():
        w = e.wrapped
        if any(w.IsEqual(s) for s in seen):
            continue
        seen.append(w)
        ed, _ = edge_to_geom_dict(e)
        edges.append((edge_geometry_hash(ed), e))
    return edges


def _edge_lineage(edge_pairs):
    return {gh: [f"@edge_{i}"] for i, (gh, _e) in enumerate(edge_pairs)}


def _sorted_lineage(lineage):
    return {k: sorted(v) for k, v in (lineage or {}).items()}


def _diff_counts(diff):
    return {
        "new_faces": len(diff.new_faces),
        "inherited_faces": len(diff.inherited_faces),
        "new_edges": len(diff.new_edges),
        "inherited_edges": len(diff.inherited_edges),
        "modified_input_faces": len(diff.modified_input_faces),
        "deleted_input_faces": len(diff.deleted_input_faces),
        "modified_input_edges": len(diff.modified_input_edges),
        "deleted_input_edges": len(diff.deleted_input_edges),
    }


def _case(name, kind, value):
    box = _box(10.0, 10.0, 10.0)
    fl = _face_lineage(box)
    edge_pairs = _edge_index(box)
    el = _edge_lineage(edge_pairs)
    # Pick a deterministic target edge: the one with the lexicographically
    # smallest geom hash (TS picks the same hash, order-independent).
    target_gh, target_edge = min(edge_pairs, key=lambda p: p[0])

    if kind == "fillet":
        shape, new_fl, new_el, diff = apply_fillet_with_lineage(
            box, value, [_ensure_occ(target_edge)], fl, el,
        )
    else:
        shape, new_fl, new_el, diff = apply_chamfer_with_lineage(
            box, value, [_ensure_occ(target_edge)], "distance", 45.0, fl, el,
        )
    return {
        "name": name,
        "kind": kind,
        "box": [10.0, 10.0, 10.0],
        "value": value,
        "target_edge_hash": target_gh,
        "face_lineage_in": _sorted_lineage(fl),
        "edge_lineage_in": _sorted_lineage(el),
        "volume": _volume(shape),
        "face_lineage_out": _sorted_lineage(new_fl),
        "edge_lineage_out": _sorted_lineage(new_el),
        "diff_counts": _diff_counts(diff),
    }


def main():
    cases = [
        _case("fillet_r2", "fillet", 2.0),
        _case("chamfer_d2", "chamfer", 2.0),
    ]
    fixture = {"cases": cases}
    here = os.path.dirname(__file__)
    out_dir = os.path.abspath(
        os.path.join(here, "..", "..", "frontend", "src", "kernel", "occ", "__fixtures__")
    )
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "fillet.json")
    with open(out_path, "w") as f:
        json.dump(fixture, f, indent=2)
    print(f"wrote {out_path} ({len(cases)} cases)")
    for c in cases:
        print(f"  {c['name']}: vol={c['volume']:.3f}, diff={c['diff_counts']}, "
              f"{len(c['face_lineage_out'])} faces / {len(c['edge_lineage_out'])} edges tagged")


if __name__ == "__main__":
    main()
