"""Integration tests for stable face/edge identity via geometry hashes."""

import importlib
import pytest

pytestmark = [
    pytest.mark.skipif(
        not importlib.util.find_spec("cadquery"), reason="cadquery not installed"
    ),
    pytest.mark.skipif(
        not importlib.util.find_spec("vtkmodules"), reason="vtkmodules not installed"
    ),
]


def _find_hash_in_ancestral(ancestral_or_snapshot, prefix: str) -> set[str]:
    """Extract hash wire tags from by_geom_hash (or legacy ancestral search).

    Accepts either an ancestral dict or a full repo snapshot dict. Hashes moved
    from ancestral keys to by_geom_hash in the geom_hash_fallback_only feature.
    """
    # New format: search by_geom_hash
    if isinstance(ancestral_or_snapshot, dict) and "by_geom_hash" in ancestral_or_snapshot:
        by_geom_hash = ancestral_or_snapshot.get("by_geom_hash", {})
        return {"@" + h for h in by_geom_hash if h.startswith(prefix)}
    # Legacy: search ancestral keys for hash wire tags
    hashes: set[str] = set()
    for key in ancestral_or_snapshot:
        for w in key:
            if isinstance(w, str) and w.startswith("@" + prefix):
                hashes.add(w)
    return hashes


def _get_face_registration_keys(ancestral):
    """Return list of frozenset keys from ancestral that contain @body_id/face<n> registrations.

    Hashes are now in by_geom_hash, not in ancestral keys. Face keys are identified
    by the @<body_id>/face<n> positional tag.
    """
    result = []
    for key in ancestral:
        for w in key:
            if isinstance(w, str) and "/face" in w and w.startswith("@"):
                result.append(key)
                break
    return result


def _get_last_checkpoint(build_result):
    """Return the last (most recent) checkpoint from a build result."""
    last_fid = None
    for fid in build_result["_build_state"].feature_order:
        if fid in build_result["_build_state"].checkpoints:
            last_fid = fid
    if last_fid:
        return build_result["_build_state"].checkpoints[last_fid]
    return None


class TestHashTagInRegistration:
    """Verify that geometry hash tags appear in registrations."""

    def test_face_registration_has_hash_tag(self):
        """Face hashes appear in by_geom_hash (not in ancestral keys) since geom_hash_fallback_only."""
        from oversolved.kernel.builder import build
        from solver_helpers import full_rect_extrude_spec

        spec = full_rect_extrude_spec(w=10, h=10, d=5)
        r = build(spec)

        ckp = _get_last_checkpoint(r)
        assert ckp is not None
        by_geom_hash = ckp.repo_snapshot.get("by_geom_hash", {})
        face_hashes = {h for h in by_geom_hash if h.startswith("gface_")}
        assert len(face_hashes) > 0, "No gface_ entries in by_geom_hash"
        # No gface_ tags appear in ancestral keys anymore
        ancestral = ckp.repo_snapshot.get("ancestral", {})
        for key in ancestral:
            for w in key:
                assert not w.startswith("@gface_"), f"geom_hash leaked into ancestral key: {w}"

    def test_edge_registration_has_hash_tag(self):
        from oversolved.kernel.builder import build
        from solver_helpers import full_rect_extrude_spec

        spec = full_rect_extrude_spec(w=10, h=10, d=5)
        r = build(spec)

        ckp = _get_last_checkpoint(r)
        assert ckp is not None
        edge_hashes = _find_hash_in_ancestral(ckp.repo_snapshot, "gedge_")
        assert len(edge_hashes) > 0, "No edge hash registrations found"

    def test_vetex_registration_has_gvertex_tag(self):
        from oversolved.kernel.builder import build
        from solver_helpers import full_rect_extrude_spec

        spec = full_rect_extrude_spec(w=10, h=10, d=5)
        r = build(spec)

        ckp = _get_last_checkpoint(r)
        assert ckp is not None
        vertex_hashes = _find_hash_in_ancestral(ckp.repo_snapshot, "gvertex_")
        assert len(vertex_hashes) > 0, "No vertex hash registrations found"


class TestHashCount:
    """Face registrations have 3 structural tags (index, feature, body); hash is in by_geom_hash."""

    def test_face_registration_has_4_tags(self):
        from oversolved.kernel.builder import build
        from solver_helpers import full_rect_extrude_spec

        spec = full_rect_extrude_spec(w=10, h=10, d=5)
        r = build(spec)

        ckp = _get_last_checkpoint(r)
        assert ckp is not None
        ancestral = ckp.repo_snapshot.get("ancestral", {})
        face_keys = _get_face_registration_keys(ancestral)
        assert len(face_keys) > 0
        for key in face_keys:
            assert len(key) == 3, f"Expected 3 structural tags (index/feature/body), got {len(key)}: {sorted(key)}"


class TestBackwardCompatibility:
    """Old 3-tag queries still resolve after hash tag is added."""

    def test_old_3tag_query_still_resolves(self):
        from oversolved.kernel.builder import build
        from oversolved.kernel.query import Repository, make_ancestry_query
        from solver_helpers import full_rect_extrude_spec

        spec = full_rect_extrude_spec(w=10, h=10, d=5)
        r = build(spec)

        face_queries = r["bodies"]["body_ex1"]["mesh"].get("face_queries", [])
        assert len(face_queries) > 0

        ckp = _get_last_checkpoint(r)
        assert ckp is not None
        snapshot = ckp.repo_snapshot
        repo = Repository()
        repo.elements = dict(snapshot.get("elements", {}))
        repo.ancestral = {k: list(v) for k, v in snapshot.get("ancestral", {}).items()}
        repo.by_geom_hash = {k: list(v) for k, v in snapshot.get("by_geom_hash", {}).items()}

        for idx, fq in enumerate(face_queries):
            old_3tag = make_ancestry_query(
                [f"@body_ex1/face{idx}", "@ex1", "@body_ex1"], None
            )
            resolved = repo.query(old_3tag)
            if resolved is not None:
                assert isinstance(resolved, dict)
                assert resolved.get("body_id") == "body_ex1"
                return
        pytest.fail("No face query resolved against the repo")

    def test_face_queries_from_build_use_hash_instead_of_index(self):
        from oversolved.kernel.builder import build
        from oversolved.kernel.query import _parse_ancestry
        from solver_helpers import full_rect_extrude_spec

        spec = full_rect_extrude_spec(w=10, h=10, d=5)
        r = build(spec)

        face_queries = r["bodies"]["body_ex1"]["mesh"].get("face_queries", [])
        assert len(face_queries) > 0
        for fq in face_queries:
            ids, _ = _parse_ancestry(fq)
            assert len(ids) == 3, f"Expected 3 tags (hash, feature, body), got {len(ids)}: {ids}"
            assert any(i.startswith("@gface_") for i in ids), f"Missing gface_ tag in {ids}"


class TestHashStability:
    """Hashes are stable for unchanged geometry and change when geometry changes."""

    def test_hash_stable_across_same_builds(self):
        from oversolved.kernel.builder import build
        from solver_helpers import full_rect_extrude_spec

        spec = full_rect_extrude_spec(w=10, h=10, d=5)
        r1 = build(spec)
        r2 = build(spec)

        ckp1 = _get_last_checkpoint(r1)
        ckp2 = _get_last_checkpoint(r2)
        assert ckp1 is not None and ckp2 is not None

        h1 = _find_hash_in_ancestral(ckp1.repo_snapshot, "gface_")
        h2 = _find_hash_in_ancestral(ckp2.repo_snapshot, "gface_")
        assert h1 and h2
        assert h1 == h2, "Face hashes differ between identical builds"

    def test_hash_shared_across_fillet(self):
        """Fillet introduces new faces but unchanged ones keep their hash."""
        from oversolved.kernel.builder import build
        from solver_helpers import full_rect_extrude_spec

        spec = full_rect_extrude_spec(w=10, h=10, d=5)
        r_before = build(spec)
        ckp_before = _get_last_checkpoint(r_before)
        assert ckp_before is not None
        hashes_before = _find_hash_in_ancestral(ckp_before.repo_snapshot, "gface_")

        spec["features"].append({
            "id": "fillet1", "kind": "fillet", "edges": ["?body_ex1:edge:0"], "radius": 1.0,
        })
        r_after = build(spec)
        ckp_after = _get_last_checkpoint(r_after)
        assert ckp_after is not None
        hashes_after = _find_hash_in_ancestral(ckp_after.repo_snapshot, "gface_")

        assert hashes_before and hashes_after
        shared = hashes_before & hashes_after
        assert len(shared) > 0, "Expected some face hashes to survive fillet"

    def test_new_face_hashes_appear_after_fillet(self):
        """Fillet introduces new cylindrical faces with new hashes."""
        from oversolved.kernel.builder import build
        from solver_helpers import full_rect_extrude_spec

        spec = full_rect_extrude_spec(w=10, h=10, d=5)
        r_before = build(spec)
        ckp_before = _get_last_checkpoint(r_before)
        assert ckp_before is not None
        hashes_before = _find_hash_in_ancestral(ckp_before.repo_snapshot, "gface_")

        spec["features"].append({
            "id": "fillet1", "kind": "fillet", "edges": ["?body_ex1:edge:0"], "radius": 3.0,
        })
        r_after = build(spec)
        ckp_after = _get_last_checkpoint(r_after)
        assert ckp_after is not None
        hashes_after = _find_hash_in_ancestral(ckp_after.repo_snapshot, "gface_")

        assert hashes_before and hashes_after
        new_hashes = hashes_after - hashes_before
        assert len(new_hashes) > 0, "Expected new face hashes after fillet"

    def test_fillet_introduces_more_faces(self):
        """Fillet increases total face count (adds cylindrical faces)."""
        from oversolved.kernel.builder import build
        from solver_helpers import full_rect_extrude_spec

        spec = full_rect_extrude_spec(w=10, h=10, d=5)
        r_before = build(spec)
        ckp_before = _get_last_checkpoint(r_before)
        assert ckp_before is not None
        before_count = len(_find_hash_in_ancestral(ckp_before.repo_snapshot, "gface_"))

        spec["features"].append({
            "id": "fillet1", "kind": "fillet", "edges": ["?body_ex1:edge:0"], "radius": 3.0,
        })
        r_after = build(spec)
        ckp_after = _get_last_checkpoint(r_after)
        assert ckp_after is not None
        after_count = len(_find_hash_in_ancestral(ckp_after.repo_snapshot, "gface_"))

        assert after_count > before_count, (
            f"Expected more faces after fillet ({after_count} <= {before_count})"
        )


class TestEdgeHashStability:
    """Edge hashes are stable for unchanged edges."""

    def test_edge_hash_stable_across_same_builds(self):
        from oversolved.kernel.builder import build
        from solver_helpers import full_rect_extrude_spec

        spec = full_rect_extrude_spec(w=10, h=10, d=5)
        r1 = build(spec)
        r2 = build(spec)

        ckp1 = _get_last_checkpoint(r1)
        ckp2 = _get_last_checkpoint(r2)
        assert ckp1 is not None and ckp2 is not None

        h1 = _find_hash_in_ancestral(ckp1.repo_snapshot, "gedge_")
        h2 = _find_hash_in_ancestral(ckp2.repo_snapshot, "gedge_")
        assert h1 and h2
        assert h1 == h2, "Edge hashes differ between identical builds"

    def test_edge_hash_shared_across_fillet(self):
        from oversolved.kernel.builder import build
        from solver_helpers import full_rect_extrude_spec

        spec = full_rect_extrude_spec(w=10, h=10, d=5)
        r_before = build(spec)
        ckp_before = _get_last_checkpoint(r_before)
        assert ckp_before is not None
        hashes_before = _find_hash_in_ancestral(ckp_before.repo_snapshot, "gedge_")

        spec["features"].append({
            "id": "fillet1", "kind": "fillet", "edges": ["?body_ex1:edge:0"], "radius": 1.0,
        })
        r_after = build(spec)
        ckp_after = _get_last_checkpoint(r_after)
        assert ckp_after is not None
        hashes_after = _find_hash_in_ancestral(ckp_after.repo_snapshot, "gedge_")

        assert hashes_before and hashes_after
        shared = hashes_before & hashes_after
        assert len(shared) > 0, "Expected some edge hashes to survive fillet"


class TestFacePayloadHasAncestry:
    """Resolved face payload includes created_by field."""

    def test_registered_face_payload_has_created_by(self):
        from oversolved.kernel.builder import build
        from oversolved.kernel.query import Repository
        from solver_helpers import full_rect_extrude_spec

        spec = full_rect_extrude_spec(w=10, h=10, d=5)
        r = build(spec)

        ckp = _get_last_checkpoint(r)
        assert ckp is not None
        snapshot = ckp.repo_snapshot
        repo = Repository()
        repo.elements = dict(snapshot.get("elements", {}))
        repo.ancestral = {k: list(v) for k, v in snapshot.get("ancestral", {}).items()}
        repo.by_geom_hash = {k: list(v) for k, v in snapshot.get("by_geom_hash", {}).items()}

        face_keys = _get_face_registration_keys(snapshot.get("ancestral", {}))
        assert len(face_keys) > 0, "No face registrations found"

        for key in face_keys:
            for eid in snapshot["ancestral"][key]:
                elem = repo.elements.get(eid)
                if isinstance(elem, dict):
                    assert "created_by" in elem, f"Face payload missing created_by: {elem}"
                    assert elem["created_by"] == "ex1"
