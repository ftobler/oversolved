"""Lineage stable-keying tests (feature: lineage-stable-keying.md).

Per-face/edge lineage was inert in the normal build path: _copy_body dropped the
lineage dicts AND the maps were keyed by OCC subshape hash, which _copy_shape
invalidates. These tests pin the fix: lineage is re-keyed on the copy-stable
geometry hash, preserved across _copy_body, and threaded into both the query and
the registration key so sibling faces resolve by their own ancestry.
"""

import pytest

from solver_helpers import extrude_spec, rect_sketch_spec


def _strip_geom_hashes(query: str) -> str:
    """Drop the @gface_/@gnormal_/@gedge_ tokens so resolution is by ancestry alone."""
    from oversolved.kernel.query import _parse_ancestry, make_ancestry_query, _is_geom_hash_id
    ids, type_r = _parse_ancestry(query)
    kept = [i for i in ids if not _is_geom_hash_id(i)]
    return make_ancestry_query(kept, type_r)


def _non_hash_ancestor_set(query: str) -> frozenset[str]:
    from oversolved.kernel.query import _parse_ancestry, _is_geom_hash_id
    ids, _ = _parse_ancestry(query)
    return frozenset(i for i in ids if not _is_geom_hash_id(i))


def _sketch_tokens(query: str) -> frozenset[str]:
    """The @sk1/<entity> per-entity tokens carried by a query."""
    return frozenset(t for t in _non_hash_ancestor_set(query) if t.startswith("@sk1/"))


def _is_side_face(query: str) -> bool:
    """A lateral face carries exactly one sketch entity token (its bounding line).

    The two caps carry the full body-wide profile blob (all four tokens) instead,
    so they tie and fall to the geom-hash tier - they are not side faces.
    """
    return len(_sketch_tokens(query)) == 1


def _build_box(distance: float = 10.0):
    """Build a 10x10 rect extrude and return (rehydrated repo, body_out)."""
    from oversolved.kernel.builder import build, _repo_from_snapshot
    sk = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex = extrude_spec("sk1", "ex1", distance=distance)
    result = build({"features": [sk, ex]})
    assert result["result"]["ex1"]["status"] == "ok"
    body_out = result["bodies"]["body_ex1"]
    final_snap = result["_build_state"].checkpoints["ex1"].repo_snapshot
    repo = _repo_from_snapshot(final_snap)
    return repo, body_out


def _face_geom_hashes(occ_shape) -> list[str]:
    """Geometry-hash key for every face of a shape (copy-stable identity)."""
    from cadquery.occ_impl import shapes as cq_shapes
    from oversolved.kernel.cadquery_ops import _compute_face_centroid, _compute_face_normal
    from oversolved.kernel.geom_hash import face_geometry_hash
    cq = cq_shapes.Shape.cast(occ_shape)
    return sorted(
        face_geometry_hash(_compute_face_centroid(f), _compute_face_normal(f))
        for f in cq.Faces()
    )


def _face_subshape_hashes(occ_shape) -> set[str]:
    """The OCC subshape hash the old keying used (copy-fragile)."""
    from cadquery.occ_impl import shapes as cq_shapes
    cq = cq_shapes.Shape.cast(occ_shape)
    return {str(hash(f.wrapped)) for f in cq.Faces()}


# ─── test 3: _copy_body preserves lineage ───

def test_copy_body_preserves_lineage():
    """A Body with non-empty lineage round-trips through _copy_body intact."""
    from oversolved.kernel.builder import _copy_body
    from oversolved.kernel.types3d import Body

    body = Body(id="body_ex1", created_by="ex1")
    body.face_lineage = {"gface_aaa": ["@sk1/bottom"], "gface_bbb": ["@sk1/top"]}
    body.edge_lineage = {"gedge_ccc": ["@sk1/left"]}

    copy = _copy_body(body)

    assert copy.face_lineage == body.face_lineage
    assert copy.edge_lineage == body.edge_lineage
    # Deep copy: mutating the copy must not touch the original.
    copy.face_lineage["gface_aaa"].append("@sk1/right")
    assert body.face_lineage["gface_aaa"] == ["@sk1/bottom"]


# ─── test 4: geom-hash keys survive a shape copy ───

def test_lineage_key_stable_across_copy():
    """Geom-hash keys match before/after _copy_shape; subshape hashes do not.

    This is the core reason the lineage maps are re-keyed on the geometry hash:
    the previous subshape-hash keys are invalidated by BRepBuilderAPI copy.
    """
    pytest.importorskip("OCP.BRepPrimAPI")
    pytest.importorskip("cadquery")
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from oversolved.kernel.builder import _copy_shape

    box = BRepPrimAPI_MakeBox(10.0, 10.0, 10.0).Solid()

    before_geom = _face_geom_hashes(box)
    before_sub = _face_subshape_hashes(box)

    copied = _copy_shape(box)
    assert copied is not None

    after_geom = _face_geom_hashes(copied)
    after_sub = _face_subshape_hashes(copied)

    assert before_geom == after_geom, "geom-hash keys must survive a shape copy"
    # The old keying scheme would have lost every key here.
    assert before_sub.isdisjoint(after_sub), (
        "subshape hashes are expected to change across a copy (regression guard)"
    )


# ─── test 1: a side face resolves by ancestry alone (geom hash stripped) ───

def test_extrude_side_face_resolves_by_ancestry():
    """A side-face query resolves to exactly one face with only ancestry tokens.

    Strips @gface_/@gnormal_ so the geom-hash tier cannot do the work; the
    per-face lineage must carry the resolution. Failed before this feature
    (lineage was inert: returned None).
    """
    pytest.importorskip("OCP.gp")
    pytest.importorskip("cadquery")
    repo, body_out = _build_box()

    mesh = body_out["mesh"]
    face_queries = mesh["face_queries"]
    face_data = mesh["face_data"]
    assert len(face_queries) == len(face_data) == 6

    side_indices = [i for i, q in enumerate(face_queries) if _is_side_face(q)]
    assert len(side_indices) == 4, f"expected 4 lineaged side faces, got {len(side_indices)}"

    for i in side_indices:
        stripped = _strip_geom_hashes(face_queries[i])
        resolved = repo.query(stripped)
        assert resolved is not None, f"side face {i} did not resolve by ancestry: {stripped!r}"
        assert resolved.get("type") in ("face", "flatface")
        # Resolved to the very face we asked about: normals agree.
        rn = resolved.get("normal")
        fn = face_data[i]["normal"]
        assert rn is not None
        dot = sum(rn[k] * fn[k] for k in range(3))
        assert abs(abs(dot) - 1.0) < 1e-6, f"resolved a different face: dot={dot}"


# ─── test 2: the four side faces carry four distinct non-hash ancestor sets ───

def test_extrude_faces_have_distinct_lineage():
    """The 4 side faces must have 4 distinct non-hash ancestor sets.

    Before this feature every face shared the identical body-wide profile blob,
    so the geom hash was the sole discriminator.
    """
    pytest.importorskip("OCP.gp")
    pytest.importorskip("cadquery")
    _repo, body_out = _build_box()
    face_queries = body_out["mesh"]["face_queries"]

    side_sets = [_non_hash_ancestor_set(q) for q in face_queries if _is_side_face(q)]
    assert len(side_sets) == 4
    assert len(set(side_sets)) == 4, f"side faces share ancestry: {side_sets}"


# ─── test 6: an extrude edge resolves by ancestry alone (mirror of test 1) ───

def test_extrude_edge_resolves_by_ancestry():
    """A corner edge resolves to exactly one edge with the geom hash stripped.

    An edge inherits a profile token from each adjacent face, so a single
    profile token alone is shared by all four edges of a side face. The four
    vertical corner edges each sit between two distinct side faces and so carry
    two distinct profile tokens -- a set unique to that one edge, which must
    resolve by ancestry alone.
    """
    pytest.importorskip("OCP.gp")
    pytest.importorskip("cadquery")
    repo, body_out = _build_box()

    corner_edges = [q for q in body_out["edge_queries"] if len(_sketch_tokens(q)) >= 2]
    assert len(corner_edges) == 4, f"expected 4 two-token corner edges, got {len(corner_edges)}"

    for q in corner_edges:
        stripped = _strip_geom_hashes(q)
        resolved = repo.query(stripped)
        assert resolved is not None, f"edge did not resolve by ancestry: {stripped!r}"
        assert resolved.get("type") in ("edge", "straightedge")


# ─── test 5: lineage propagates through a fillet (ancestry alone still resolves) ───

def test_fillet_targets_picked_rim_via_ancestry():
    """An inherited side face still resolves by ancestry alone after a fillet.

    _extract_edge_modifier_lineage re-keys the carried-over lineage onto the
    filleted shape's geometry hashes; a side face untouched by the fillet keeps
    its single-token lineage, so the hash-stripped query resolves to it uniquely.
    """
    pytest.importorskip("OCP.gp")
    pytest.importorskip("cadquery")
    from oversolved.kernel.builder import build, _repo_from_snapshot

    sk = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex = extrude_spec("sk1", "ex1", distance=10.0)
    spec = {"features": [sk, ex]}
    r0 = build(spec)
    body0 = r0["bodies"]["body_ex1"]
    edge_q = next(q for ed, q in zip(body0["edges"], body0["edge_queries"]) if ed.get("kind") == "line")

    spec["features"].append(
        {"id": "fillet1", "kind": "fillet", "label": "Fillet", "edges": [edge_q], "radius": 1.0}
    )
    r = build(spec)
    assert r["result"]["fillet1"]["status"] == "ok"

    body = r["bodies"]["body_ex1"]
    repo = _repo_from_snapshot(r["_build_state"].checkpoints["fillet1"].repo_snapshot)

    side_queries = [q for q in body["mesh"]["face_queries"] if _is_side_face(q)]
    assert side_queries, "no inherited side face kept its lineage through the fillet"

    for q in side_queries:
        resolved = repo.query(_strip_geom_hashes(q))
        assert resolved is not None, f"post-fillet side face did not resolve by ancestry: {q!r}"
        assert resolved.get("type") in ("face", "flatface")


# ─── circle profiles: entity id flows through the closed-circle edge ───

def _cylinder_spec(radius: float = 10.0, distance: float = 10.0) -> dict:
    """A single circle sketch extruded into a cylinder."""
    sketch = {
        "id": "sk_cyl", "kind": "sketch", "label": "circle",
        "plane": "@builtin_plane_top",
        "entities": [{"id": "circ", "kind": "circle"}],
        "initial": {"circ": [0, 0, radius]},
        "constraints": [
            {"id": "cc", "kind": "coincident", "a": "$circcenter", "b": "@builtin_origin"},
            {"id": "cd", "kind": "diameter", "target": "$circ", "value": 2 * radius, "pos": [0, 0]},
        ],
    }
    extrude = {"id": "ex_cyl", "kind": "extrude", "label": "extrude",
               "sketch": "$sk_cyl", "distance": distance, "direction": "normal"}
    return {"features": [sketch, extrude]}


def test_cylinder_side_face_resolves_by_circle_ancestry():
    """The lateral face of a cylinder carries its source circle's lineage.

    A circle profile is a single closed OCC edge described as two semicircle
    arcs, so the entity id is matched by center+radius rather than endpoints.
    The cylinder wall then resolves by ancestry alone (the two caps carry no
    profile token); the two rims legitimately share the circle and stay a
    geom-hash tie.
    """
    pytest.importorskip("OCP.gp")
    pytest.importorskip("cadquery")
    from oversolved.kernel.builder import build, _repo_from_snapshot

    r = build(_cylinder_spec())
    assert r["result"]["ex_cyl"]["status"] == "ok"
    body_out = r["bodies"]["body_ex_cyl"]
    repo = _repo_from_snapshot(r["_build_state"].checkpoints["ex_cyl"].repo_snapshot)

    wall_queries = [
        q for q in body_out["mesh"]["face_queries"]
        if "@sk_cyl/circ" in _non_hash_ancestor_set(q)
    ]
    assert len(wall_queries) == 1, f"expected one lineaged cylinder wall, got {len(wall_queries)}"

    resolved = repo.query(_strip_geom_hashes(wall_queries[0]))
    assert resolved is not None, "cylinder wall did not resolve by ancestry alone"
    assert resolved.get("type") in ("face", "cylinderface")


# ─── boolean-new faces resolve by ancestry to the cutting feature ───

def _thru_cut_spec():
    """A 10x10x10 box (ex1) with a 4x4 thru-hole cut (ex2)."""
    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=10.0)
    sk2 = rect_sketch_spec(w=4.0, h=4.0, sketch_id="sk2")
    sk2["initial"] = {"bottom": [3, 3, 7, 3], "right": [7, 3, 7, 7],
                      "top": [7, 7, 3, 7], "left": [3, 7, 3, 3]}
    ex2 = {"id": "ex2", "kind": "extrude", "label": "cut", "sketch": "$sk2",
           "distance": 10.0, "direction": "normal", "operation": "cut"}
    return {"features": [sk1, ex1, sk2, ex2]}


def test_boolean_new_face_resolves_by_ancestry_to_cutting_feature():
    """A cut wall resolves by ancestry alone to the CUTTING feature (ex2).

    Boolean-new faces are tagged @created_by = modified_by[-1] (the cutting
    feature) in both the mesh query and the registration; the boolean lineage
    re-key also gives them the cutter's profile tokens. So a hash-stripped cut
    wall query resolves to exactly one ex2-owned face -- closing the old
    created_by divergence where new faces could only resolve by geometry hash.
    """
    pytest.importorskip("OCP.gp")
    pytest.importorskip("cadquery")
    from oversolved.kernel.builder import build, _repo_from_snapshot

    r = build(_thru_cut_spec())
    assert r["result"]["ex2"]["status"] == "ok"
    body_out = r["bodies"]["body_ex1"]
    repo = _repo_from_snapshot(r["_build_state"].checkpoints["ex2"].repo_snapshot)

    cut_walls = [q for q in body_out["mesh"]["face_queries"] if "@sk2/" in str(_non_hash_ancestor_set(q))]
    assert len(cut_walls) == 4, f"expected 4 cut walls tagged to ex2, got {len(cut_walls)}"

    for q in cut_walls:
        nonhash = _non_hash_ancestor_set(q)
        assert "@ex2" in nonhash and "@ex1" not in nonhash, (
            f"cut wall should be owned by the cutting feature ex2, not ex1: {sorted(nonhash)}"
        )
        resolved = repo.query(_strip_geom_hashes(q))
        assert resolved is not None, f"cut wall did not resolve by ancestry: {q!r}"
        assert resolved.get("created_by") == "ex2", (
            f"resolved face created_by={resolved.get('created_by')}, expected ex2 "
            "(query/registration created_by must agree)"
        )
