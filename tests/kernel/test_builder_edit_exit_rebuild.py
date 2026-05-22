"""Regression tests for the user invariant:

    "Editing a feature then exiting must rebuild all downstream features against
     the modified result. Rollback/cache must be correctly re-applied on exit."

These tests simulate the backend-side of the edit-exit flow:

  1. Full build of stack [sk1, ex1, fil1, ch1].
  2. Capture geometry hash of the chamfered body.
  3. Mutate the extrude distance (the user's "I changed a parameter in edit mode").
  4. Re-call build() with the FULL feature list and prev_state set to the
     post-edit state -- this is what the frontend should send on exit.
  5. Assert the chamfer is present in the result AND its geometry differs from
     the captured hash (i.e., it was re-solved against the new extrude, not
     restored from a stale checkpoint).

If _find_first_dirty fails to mark the edited feature as dirty, the
downstream features would silently keep their old checkpoint values and the
mesh hash check below would fail -- exposing the backend half of the
"edit exit rebuild" bug class even if the frontend fix lands.
"""

import hashlib

import pytest

from solver_helpers import rect_sketch_spec, extrude_spec


def _mesh_hash(body: dict) -> str:
    """Stable hash of a body mesh's vertex/index buffers (handles nested lists)."""
    mesh = body["mesh"]
    h = hashlib.sha256()

    def feed(value):
        if isinstance(value, (list, tuple)):
            for v in value:
                feed(v)
            h.update(b";")
        elif isinstance(value, (int, float)):
            h.update(f"{round(float(value), 6)}|".encode())
        else:
            h.update(repr(value).encode())

    feed(mesh.get("vertices", []))
    h.update(b"||")
    feed(mesh.get("indices", []))
    return h.hexdigest()


def _build_stack(distance: float):
    """Build [sk1, ex1, fil1, ch1] and return (build_result, edge_query_used_by_fillet)."""
    from oversolved.kernel.builder import build

    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=distance)

    # First pass: just sk1 + ex1, so we can pull a valid edge query for the fillet.
    seed = build({"features": [sk1, ex1]})
    body_id = next(bid for bid in seed["bodies"] if seed["bodies"][bid]["created_by"] == "ex1")
    edge_queries = seed["bodies"][body_id]["edge_queries"]
    assert len(edge_queries) >= 2, "need at least two edges on the box"

    # Use index-based queries so the fillet/chamfer resolve correctly even after
    # the extrude distance changes (hash-based queries become stale when the
    # geometry changes). Index queries are stable across parameter edits.
    index_q0 = f"?{body_id}:edge:0"
    index_q1 = f"?{body_id}:edge:1"

    fillet = {
        "id": "fil1",
        "kind": "fillet",
        "label": "Fillet",
        "edges": [index_q0],
        "radius": 0.5,
    }
    chamfer = {
        "id": "ch1",
        "kind": "chamfer",
        "label": "Chamfer",
        "edges": [index_q1],
        "distance": 0.5,
    }

    full = build({"features": [sk1, ex1, fillet, chamfer]})
    return full, edge_queries


def test_rollback_edit_exit_rebuilds_downstream():
    """sk1 -> ex1 -> fil1 -> ch1: mutate ex1 distance, rebuild full, chamfer must
    reflect the new geometry (mesh hash differs)."""
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build

    r1, edge_queries = _build_stack(distance=5.0)
    state1 = r1["_build_state"]

    assert r1["result"]["ch1"]["status"] == "ok"
    ch_body_id_1 = next(bid for bid in r1["bodies"] if "ch1" in r1["bodies"][bid].get("featured_by", []) or r1["bodies"][bid]["created_by"] in ("ex1", "ch1"))
    hash_before = _mesh_hash(r1["bodies"][ch_body_id_1])

    # Simulate "user edited ex1 distance to 8.0 inside edit mode".
    body_id = next(bid for bid in r1["bodies"] if r1["bodies"][bid]["created_by"] == "ex1")
    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex1_modified = extrude_spec("sk1", "ex1", distance=8.0)
    fillet = {
        "id": "fil1", "kind": "fillet", "label": "Fillet",
        "edges": [f"?{body_id}:edge:0"], "radius": 0.5,
    }
    chamfer = {
        "id": "ch1", "kind": "chamfer", "label": "Chamfer",
        "edges": [f"?{body_id}:edge:1"], "distance": 0.5,
    }

    # This is what the frontend should send on edit exit: FULL feature list,
    # rollback at end, prev_state from before.
    r2 = build({"features": [sk1, ex1_modified, fillet, chamfer]}, prev_state=state1)

    # Downstream features must be present and ok.
    assert "fil1" in r2["result"], "fillet dropped on rebuild"
    assert "ch1" in r2["result"], "chamfer dropped on rebuild"
    assert r2["result"]["fil1"]["status"] == "ok", f"fillet failed: {r2['result']['fil1']}"
    assert r2["result"]["ch1"]["status"] == "ok", f"chamfer failed: {r2['result']['ch1']}"

    # The chamfer mesh must have actually changed -- if _find_first_dirty failed
    # to mark ex1 dirty, fil1 and ch1 would be restored from stale checkpoints
    # and the mesh hash would match.
    ch_body_id_2 = next(bid for bid in r2["bodies"] if r2["bodies"][bid]["created_by"] in ("ex1", "ch1"))
    hash_after = _mesh_hash(r2["bodies"][ch_body_id_2])
    assert hash_after != hash_before, (
        "chamfer mesh unchanged after extrude parameter mutation -- "
        "downstream features were not re-solved against the new extrude"
    )


def test_find_first_dirty_after_param_edit():
    """Isolated check: after mutating only ex1's distance, _find_first_dirty
    should return the index of ex1, not later. If this fails, the rebuild
    skips downstream features even when the frontend sends the right payload."""
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build, _find_first_dirty

    r1, edge_queries = _build_stack(distance=5.0)
    state1 = r1["_build_state"]

    body_id = next(bid for bid in r1["bodies"] if r1["bodies"][bid]["created_by"] == "ex1")
    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex1_modified = extrude_spec("sk1", "ex1", distance=8.0)
    fillet = {
        "id": "fil1", "kind": "fillet", "label": "Fillet",
        "edges": [f"?{body_id}:edge:0"], "radius": 0.5,
    }
    chamfer = {
        "id": "ch1", "kind": "chamfer", "label": "Chamfer",
        "edges": [f"?{body_id}:edge:1"], "distance": 0.5,
    }

    new_features = [sk1, ex1_modified, fillet, chamfer]
    first_dirty = _find_first_dirty(new_features, state1)
    # ex1 is at index 1
    assert first_dirty == 1, (
        f"expected first_dirty == 1 (ex1), got {first_dirty}; "
        "modifying ex1 parameters must mark ex1 dirty"
    )

    # Sanity: full build with the modified ex1 still succeeds.
    r2 = build({"features": new_features}, prev_state=state1)
    assert r2["result"]["ch1"]["status"] == "ok"
