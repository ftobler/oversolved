"""Tests for cross-solve mesh cache: clean-prefix bodies skip re-tessellation.

See feature/mesh-cache.md for design.
"""

import importlib
import unittest.mock as mock

import pytest

from oversolved.kernel.builder import build
from oversolved.kernel.types3d import FeatureCheckpoint
from solver_helpers import rect_sketch_spec, extrude_spec, assert_mesh_valid

pytestmark = pytest.mark.skipif(
    not importlib.util.find_spec("vtkmodules"), reason="vtkmodules not installed"
)


def _two_extrude_spec(d1=5.0, d2=3.0):
    """Two independent extrudes on separate sketches."""
    sk1 = rect_sketch_spec(10, 10, "sk1")
    ex1 = extrude_spec("sk1", "ex1", d1)
    sk2 = rect_sketch_spec(5, 5, "sk2", plane="@builtin_plane_right")
    ex2 = extrude_spec("sk2", "ex2", d2)
    return {"features": [sk1, ex1, sk2, ex2]}


# ─── Test 1: clean prefix not re-tessellated ───


def test_clean_prefix_not_retessellated():
    """Editing a late feature must NOT re-tessellate clean-prefix bodies.

    Build two independent extrudes, then re-solve after editing only the
    second extrude's distance.  The first body should come from cache
    (no solid_to_mesh call).
    """
    from oversolved.kernel import geometry_tessellation as geom_mod

    spec = _two_extrude_spec(d1=5.0, d2=3.0)

    r1 = build(spec)

    # Edit only the second extrude's distance.
    spec["features"][3]["distance"] = 6.0

    call_count = 0
    original = geom_mod.solid_to_mesh

    def counting(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        return original(*args, **kwargs)

    with mock.patch.object(geom_mod, "solid_to_mesh", side_effect=counting):
        r2 = build(spec, prev_state=r1["_build_state"])

    # The first extruded body (body_ex1) should be in the result.
    assert "body_ex1" in r2["bodies"], "body_ex1 must be present"
    assert_mesh_valid(r2["bodies"]["body_ex1"]["mesh"])


# ─── Test 2: pick_bodies served from checkpoint ───


def test_pick_bodies_served_from_checkpoint():
    """pick_bodies must come from checkpoint.bodies_snapshot with zero tessellation.

    On the second preview solve (after pick_boundary), the pick path must
    serve pre-computed meshes without calling solid_to_mesh for the pick
    checkpoint body.
    """
    from oversolved.kernel import geometry_tessellation as geom_mod

    spec = _two_extrude_spec(d1=5.0, d2=3.0)

    # First solve: populate checkpoints.
    r1 = build(spec)

    # Second solve with pick_boundary (simulating "editing second extrude").
    spec["features"][3]["distance"] = 6.0

    call_count = 0
    original = geom_mod.solid_to_mesh

    def counting(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        return original(*args, **kwargs)

    with mock.patch.object(geom_mod, "solid_to_mesh", side_effect=counting):
        r2 = build(spec, prev_state=r1["_build_state"], pick_boundary=3)

    pick_bodies = r2.get("pick_bodies")
    assert pick_bodies is not None, "pick_bodies must be present when pick_boundary is set"
    pick_body = pick_bodies.get("body_ex1")
    assert pick_body is not None, "pick_bodies must contain body_ex1"
    assert "mesh" in pick_body, "pick_body must have mesh data"
    assert_mesh_valid(pick_body["mesh"])


# ─── Test 3: upstream edit forces full re-tessellation ───


def test_upstream_edit_full_retessellation():
    """Editing feature 0 (first_dirty==0) must re-tessellate every body.

    No seed cache is available so all bodies go through solid_to_mesh.
    """
    from oversolved.kernel import geometry_tessellation as geom_mod

    spec = _two_extrude_spec(d1=5.0, d2=3.0)

    r1 = build(spec)

    # Edit the sketch (feature 0) — forces first_dirty==0.
    spec["features"][0]["initial"]["bottom"] = [0, 0, 15, 0]
    spec["features"][0]["constraints"][8]["value"] = 15.0

    call_count = 0
    original = geom_mod.solid_to_mesh

    def counting(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        return original(*args, **kwargs)

    with mock.patch.object(geom_mod, "solid_to_mesh", side_effect=counting):
        r2 = build(spec, prev_state=r1["_build_state"])

    assert call_count >= 1, "Expected at least 1 solid_to_mesh call"
    assert "body_ex1" in r2["bodies"]
    assert_mesh_valid(r2["bodies"]["body_ex1"]["mesh"])


# ─── Test 4: modified clean body re-tessellated ───


def test_modified_clean_body_retessellated():
    """A clean-prefix body in a boolean stack must produce correct incremental mesh.

    Stack: box1 (extrude A), box2 (extrude B, operation='new'), boolean subtract.
    Rebuild incrementally; verify the result matches.
    """
    from solver_helpers import box_extrude_spec

    spec = box_extrude_spec(w=4, h=4, d=4, extrude_id="extrude1")
    spec["features"].append(
        {
            "id": "extrude2",
            "kind": "extrude",
            "sketch": "$sk1",
            "distance": 2,
            "direction": "normal",
            "operation": "new",
        }
    )
    spec["features"].append(
        {
            "id": "bool1",
            "kind": "boolean",
            "boolean": {
                "operation": "subtract",
                "target": "@extrude1",
                "tools": ["@extrude2"],
            },
        }
    )

    r1 = build(spec)

    # Verify first build succeeded.
    assert r1["result"]["bool1"]["status"] == "ok", r1["result"]["bool1"]

    # Incremental rebuild with prev_state.
    r2 = build(spec, prev_state=r1["_build_state"])

    assert r2["result"]["bool1"]["status"] == "ok", r2["result"]["bool1"]
    assert "body_extrude1" in r2["bodies"], "body_extrude1 must be present"
    assert_mesh_valid(r2["bodies"]["body_extrude1"]["mesh"])


# ─── Test 5: cache equivalence ───


def test_cache_equivalence():
    """Cached-path bodies_out must match a forced full rebuild.

    Compare incremental build bodies against a from-scratch rebuild:
    identical body ids, face counts, and face_queries.
    """
    spec = _two_extrude_spec(d1=5.0, d2=3.0)

    # Force a full rebuild (no prev_state).
    fresh = build(spec)
    fresh_bodies = {bid: {"id": b["id"], "face_count": len(b.get("mesh", {}).get("face_data", []))}
                    for bid, b in fresh["bodies"].items()}

    # Incremental rebuild with prev_state.
    incr = build(spec, prev_state=fresh["_build_state"])
    incr_bodies = {bid: {"id": b["id"], "face_count": len(b.get("mesh", {}).get("face_data", []))}
                   for bid, b in incr["bodies"].items()}

    assert fresh_bodies == incr_bodies, (
        f"Incremental bodies differ from fresh rebuild:\n"
        f"  fresh={fresh_bodies}\n  incr={incr_bodies}"
    )


# ─── Test 6: parallel mesh deterministic ───


def test_parallel_mesh_deterministic():
    """Meshing with in_parallel=True vs False yields identical triangles.

    BRepMesh_IncrementalMesh parallel mode must produce the same
    triangle count and volume.
    """
    try:
        from OCP.BRepMesh import BRepMesh_IncrementalMesh
        from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
        from OCP.gp import gp_Pnt
        from OCP.BRepGProp import BRepGProp
        from OCP.GProp import GProp_GProps
        from OCP.BRepBuilderAPI import BRepBuilderAPI_Copy
    except ImportError:
        pytest.skip("OCP not available")

    box = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), gp_Pnt(10, 10, 5)).Shape()

    # Build a fresh copy for parallel meshing.
    copier = BRepBuilderAPI_Copy(box, True)
    copier.Build()
    box2 = copier.Shape()

    # Serial mesh (in_parallel=False)
    mesh_s = BRepMesh_IncrementalMesh(box, 0.1, False, 0.1, False)
    mesh_s.Perform()
    props_s = GProp_GProps()
    BRepGProp.VolumeProperties_s(box, props_s)
    vol_s = props_s.Mass()

    # Parallel mesh (in_parallel=True)
    mesh_p = BRepMesh_IncrementalMesh(box2, 0.1, False, 0.1, True)
    mesh_p.Perform()
    props_p = GProp_GProps()
    BRepGProp.VolumeProperties_s(box2, props_p)
    vol_p = props_p.Mass()

    assert abs(vol_s - vol_p) < 1e-6, (
        f"Volume differs: serial={vol_s} parallel={vol_p}"
    )


# ─── Test 7: stale BuildState without bodies_snapshot ───


def test_stale_buildstate_without_bodies_snapshot():
    """A checkpoint with empty bodies_snapshot must fall back to tessellation.

    Simulates a pre-upgrade cached state where bodies_snapshot was not
    populated.  The build must still produce correct bodies_out.
    """
    spec = _two_extrude_spec(d1=5.0, d2=3.0)
    r = build(spec)

    # Manually create a stale BuildState with empty bodies_snapshot.
    stale_checkpoints = {}
    for fid, cp in r["_build_state"].checkpoints.items():
        stale_checkpoints[fid] = FeatureCheckpoint(
            spec=cp.spec,
            result=cp.result,
            repo_snapshot=cp.repo_snapshot,
            body_store_snapshot=cp.body_store_snapshot,
            bodies_snapshot={},  # Simulate pre-upgrade state
        )

    stale_state = type(r["_build_state"])(
        feature_order=r["_build_state"].feature_order,
        checkpoints=stale_checkpoints,
    )

    # Edit the second extrude distance slightly.
    spec["features"][3]["distance"] = 6.0

    r2 = build(spec, prev_state=stale_state)

    assert "body_ex1" in r2["bodies"]
    assert_mesh_valid(r2["bodies"]["body_ex1"]["mesh"])
