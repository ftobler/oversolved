"""Geometric-classifier resolver-tier tests (feature: geometric-classifiers.md).

A stable resolver tier between ancestry and the edit-fragile geometry hash:
edit-stable @cls_* tokens (Phase 1: cardinal/axial position vs the body AABB)
disambiguate genuine ancestral siblings (extrude caps, cylinder rims) and, unlike
the geom-hash, survive parametric edits -- the only edit-stable discriminator for
sibling edges, which have no @gnormal_ fallback.

The 2D sketch-surface primitives (classify_surface_*) are tested separately in
test_geometric_classifiers.py; this file covers the new 3D axial classifier and
its wiring into query emission and resolution.
"""

import pytest

from oversolved.kernel.geom_hash import geometry_classifiers
from oversolved.kernel.query import _is_classifier_id, _is_geom_hash_id


# ─── unit: classifier math ───

class TestGeometryClassifiers:
    def test_axial_offset_emits_sign_token(self):
        center, half = [0.0, 0.0, 0.0], [5.0, 5.0, 5.0]
        assert geometry_classifiers([0, 0, 5], center, half) == ["cls_zp"]
        assert geometry_classifiers([0, 0, -5], center, half) == ["cls_zn"]
        assert geometry_classifiers([5, 0, 0], center, half) == ["cls_xp"]

    def test_centered_point_emits_nothing(self):
        # Mid-body on every axis -> no classifier (e.g. a cylinder seam midpoint).
        assert geometry_classifiers([0, 0, 0], [0, 0, 0], [5, 5, 5]) == []

    def test_corner_emits_multiple_axes(self):
        toks = geometry_classifiers([5, 5, 5], [0, 0, 0], [5, 5, 5])
        assert set(toks) == {"cls_xp", "cls_yp", "cls_zp"}

    def test_degenerate_axis_skipped(self):
        # A flat profile (zero z extent) classifies only in x/y.
        assert geometry_classifiers([5, 0, 0], [0, 0, 0], [5, 5, 0.0]) == ["cls_xp"]

    def test_below_threshold_emits_nothing(self):
        # Inside half the half-extent -> not "clearly" on a side.
        assert geometry_classifiers([0, 0, 2.0], [0, 0, 0], [5, 5, 5]) == []

    def test_translation_and_scale_stable_sign(self):
        a = geometry_classifiers([0, 0, 10], [0, 0, 5], [5, 5, 5])
        b = geometry_classifiers([0, 0, 30], [0, 0, 15], [15, 15, 15])
        assert a == b == ["cls_zp"]


class TestClassifierTokenPredicate:
    def test_recognises_cls_prefix(self):
        assert _is_classifier_id("@cls_zp")
        assert _is_classifier_id("@cls_xn")

    def test_rejects_non_classifier(self):
        assert not _is_classifier_id("@gface_abc")
        assert not _is_classifier_id("@ex1")
        assert not _is_classifier_id("@sk1/left")

    def test_classifier_is_not_a_geom_hash(self):
        # The partitions must be disjoint: @cls_* is neither ancestry nor hash.
        assert not _is_geom_hash_id("@cls_zp")


# ─── unit: AABB frame ───

def test_body_aabb_frame_centers_a_box():
    pytest.importorskip("OCP.BRepPrimAPI")
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from oversolved.kernel.geometry_tessellation import body_aabb_frame

    box = BRepPrimAPI_MakeBox(10.0, 20.0, 30.0).Solid()
    center, half = body_aabb_frame(box)
    assert center == pytest.approx([5.0, 10.0, 15.0])
    assert half == pytest.approx([5.0, 10.0, 15.0])


# ─── helpers for the wired-resolution tests ───

from solver_helpers import rect_sketch_spec, extrude_spec  # noqa: E402


def _parse(query):
    from oversolved.kernel.query import _parse_ancestry
    return _parse_ancestry(query)


def _rebuild(query, *, keep_hash=True, keep_cls=True):
    """Re-emit a query keeping/dropping the geom-hash and/or classifier tokens."""
    from oversolved.kernel.query import (
        _parse_ancestry, make_ancestry_query, _is_geom_hash_id, _is_classifier_id,
    )
    ids, t = _parse_ancestry(query)
    kept = [
        i for i in ids
        if (keep_hash or not _is_geom_hash_id(i)) and (keep_cls or not _is_classifier_id(i))
    ]
    return make_ancestry_query(kept, t)


def _cls_tokens(query):
    from oversolved.kernel.query import _parse_ancestry, _is_classifier_id
    ids, _ = _parse_ancestry(query)
    return [i for i in ids if _is_classifier_id(i)]


def _top_plane_box(w=10.0, h=10.0, d=4.0):
    """Build a box on the top plane (caps are +Z / -Z) -> (repo, body_out)."""
    from oversolved.kernel.builder import build, _repo_from_snapshot
    sk = rect_sketch_spec(w=w, h=h, sketch_id="sk1", plane="@builtin_plane_top")
    ex = extrude_spec("sk1", "ex1", distance=d)
    r = build({"features": [sk, ex]})
    assert r["result"]["ex1"]["status"] == "ok"
    repo = _repo_from_snapshot(r["_build_state"].checkpoints["ex1"].repo_snapshot)
    return repo, r["bodies"]["body_ex1"]


def _cap_queries(body_out):
    """The ancestral-sibling face group: faces sharing identical ancestry.

    For a single-profile extrude this is exactly the two caps (the four side
    faces are each lineage-distinct). Found by ancestry, so it is independent of
    how the sketch plane maps onto world axes.
    """
    from collections import defaultdict
    groups: dict[str, list[str]] = defaultdict(list)
    for q in body_out["mesh"]["face_queries"]:
        groups[_rebuild(q, keep_hash=False, keep_cls=False)].append(q)
    siblings = [qs for qs in groups.values() if len(qs) >= 2]
    return max(siblings, key=len) if siblings else []


# ─── test 1: caps carry opposite axial classifiers ───

def test_classifier_tokens_emitted_on_caps():
    pytest.importorskip("OCP.gp")
    pytest.importorskip("cadquery")
    _repo, body_out = _top_plane_box()
    caps = _cap_queries(body_out)
    assert len(caps) == 2
    # Each cap carries exactly one classifier; the two are opposite signs on the
    # same axis (the extrude axis). Which world axis depends on the sketch plane.
    toks = [_cls_tokens(q) for q in caps]
    assert all(len(t) == 1 for t in toks), toks
    a, b = sorted(t[0] for t in toks)
    assert a[:-1] == b[:-1] and {a[-1], b[-1]} == {"n", "p"}, (a, b)


# ─── test 2: caps resolve by classifier alone (geom hash stripped) ───

def test_caps_resolve_by_classifier_without_geom_hash():
    pytest.importorskip("OCP.gp")
    pytest.importorskip("cadquery")
    repo, body_out = _top_plane_box()
    caps = _cap_queries(body_out)
    assert len(caps) == 2

    for q in caps:
        # Ancestry + classifier (no geom hash): resolves to exactly one cap.
        resolved = repo.query(_rebuild(q, keep_hash=False, keep_cls=True))
        assert resolved is not None, f"cap did not resolve by classifier: {q!r}"
        assert resolved.get("type") in ("face", "flatface")
        # Drop the classifier too and the two caps are indistinguishable: ambiguous.
        from oversolved.kernel.query import AmbiguousQueryError
        with pytest.raises(AmbiguousQueryError):
            repo.query(_rebuild(q, keep_hash=False, keep_cls=False))


# ─── test 7: queries with no classifier token are unaffected ───

def test_existing_queries_unaffected_by_classifier_tier():
    pytest.importorskip("OCP.gp")
    pytest.importorskip("cadquery")
    repo, body_out = _top_plane_box()
    # A pre-feature query carries no @cls_ token; the tier must be skipped and the
    # full query must still resolve exactly as before (here via the geom hash).
    for q in body_out["mesh"]["face_queries"]:
        no_cls = _rebuild(q, keep_hash=True, keep_cls=False)
        assert _cls_tokens(no_cls) == []
        assert repo.query(no_cls) is not None, f"classifier-free query regressed: {no_cls!r}"


# ─── edges: the headline case (no @gnormal_ fallback for edges) ───

def _cylinder_spec(radius=10.0, distance=10.0):
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


def _build_cyl(radius=10.0, distance=10.0):
    from oversolved.kernel.builder import build, _repo_from_snapshot
    r = build(_cylinder_spec(radius, distance))
    assert r["result"]["ex_cyl"]["status"] == "ok"
    repo = _repo_from_snapshot(r["_build_state"].checkpoints["ex_cyl"].repo_snapshot)
    return r, repo, r["bodies"]["body_ex_cyl"]


def _rim_queries(body_out):
    """The two full-circle rim edge queries (the ancestral-sibling edges)."""
    return [
        q for ed, q in zip(body_out["edges"], body_out["edge_queries"])
        if ed.get("kind") == "circle"
    ]


def test_cylinder_rims_resolve_by_classifier():
    """The two cylinder rims share ancestry and have no normal fallback; the
    axial classifier is the only thing that tells them apart by ancestry."""
    pytest.importorskip("OCP.gp")
    pytest.importorskip("cadquery")
    _r, repo, body_out = _build_cyl()
    rims = _rim_queries(body_out)
    assert len(rims) == 2

    seen_centroids = []
    for q in rims:
        # one classifier token, opposite signs on the extrude axis
        assert len(_cls_tokens(q)) == 1, _cls_tokens(q)
        resolved = repo.query(_rebuild(q, keep_hash=False, keep_cls=True))
        assert resolved is not None, f"rim did not resolve by classifier: {q!r}"
        assert resolved.get("type") in ("edge", "straightedge")
        # without the classifier the two rims are an ancestral tie
        from oversolved.kernel.query import AmbiguousQueryError
        with pytest.raises(AmbiguousQueryError):
            repo.query(_rebuild(q, keep_hash=False, keep_cls=False))
        seen_centroids.append(tuple(resolved.get("start") or resolved.get("center") or ()))
    assert _cls_tokens(rims[0]) != _cls_tokens(rims[1]), "rims must carry opposite tokens"


def test_classifier_survives_height_edit():
    """The value proposition: capture the top-rim query, rebuild at a different
    height so the @gedge_ hash stales, and the captured query still resolves to
    the new top rim via the axial classifier (no edge normal fallback exists)."""
    pytest.importorskip("OCP.gp")
    pytest.importorskip("cadquery")
    from oversolved.kernel.builder import build, _repo_from_snapshot
    from oversolved.kernel.query import _parse_ancestry, _is_geom_hash_id

    _r, _repo, body0 = _build_cyl(distance=10.0)
    rims = _rim_queries(body0)
    # pick the rim whose classifier is the +axis end (the "top" rim)
    top_q = next(q for q in rims if any(t.endswith("p") for t in _cls_tokens(q)))
    top_token = _cls_tokens(top_q)[0]

    # Rebuild taller: the rim moves, so its precise @gedge_ hash goes stale.
    r2 = build(_cylinder_spec(distance=25.0))
    repo2 = _repo_from_snapshot(r2["_build_state"].checkpoints["ex_cyl"].repo_snapshot)

    old_hash = [i for i in _parse_ancestry(top_q)[0] if _is_geom_hash_id(i)]
    assert old_hash, "expected a @gedge_ hash on the original rim query"
    # Sanity: the stale hash no longer identifies anything in the taller build.
    assert repo2.query(make_hash_only(top_q)) is None

    # The full captured query still resolves -- via the classifier, not the hash.
    resolved = repo2.query(top_q)
    assert resolved is not None, "stale rim query failed to re-resolve via classifier"
    assert resolved.get("type") in ("edge", "straightedge")
    # and it is the +axis (top) rim of the taller cylinder, not the bottom one
    # (a circle edge's payload carries no start point, so check its classifier).
    assert top_token.endswith("p")
    assert top_token[1:] in resolved.get("classifiers", []), resolved.get("classifiers")
    assert top_token.replace("p", "n")[1:] not in resolved.get("classifiers", [])


def make_hash_only(query):
    """The query reduced to just its geom-hash tokens + type (no ancestry/classifier)."""
    from oversolved.kernel.query import _parse_ancestry, make_ancestry_query, _is_geom_hash_id
    ids, t = _parse_ancestry(query)
    return make_ancestry_query([i for i in ids if _is_geom_hash_id(i)], t)


# ─── test 5: the classifier tier degrades gracefully ───

def test_classifier_tier_is_graceful():
    """A classifier set that matches no candidate must NOT zero the result: the
    tier is skipped (narrowed set empty) and the geom hash still resolves."""
    pytest.importorskip("OCP.gp")
    pytest.importorskip("cadquery")
    from oversolved.kernel.query import _parse_ancestry, make_ancestry_query
    repo, body_out = _top_plane_box()
    caps = _cap_queries(body_out)
    cap = caps[0]
    cap_tokens = _cls_tokens(cap)
    assert len(cap_tokens) == 1
    # Add the OPPOSITE-sign token: no face is both +axis and -axis, so the
    # classifier narrowing yields nothing and must fall through to the hash.
    contradictory = cap_tokens[0][:-1] + ("n" if cap_tokens[0].endswith("p") else "p")
    ids, t = _parse_ancestry(cap)
    bogus = make_ancestry_query(ids + [contradictory], t)
    resolved = repo.query(bogus)
    assert resolved is not None, "contradictory classifier zeroed a hash-resolvable query"
    assert resolved.get("type") in ("face", "flatface")


# ─── test 8: query tokens equal the registered payload classifiers ───

def test_classifier_payload_matches_query():
    """Single source of truth: the @cls_* tokens a face query carries equal the
    bare classifier list registered on the element it resolves to."""
    pytest.importorskip("OCP.gp")
    pytest.importorskip("cadquery")
    repo, body_out = _top_plane_box()
    for q in body_out["mesh"]["face_queries"]:
        resolved = repo.query(q)
        assert resolved is not None
        query_cls = sorted(t[1:] for t in _cls_tokens(q))  # strip '@'
        assert sorted(resolved.get("classifiers", [])) == query_cls, (q, resolved.get("classifiers"))


# ─── Phase 2: line-division classifiers for same-ancestry sketch surfaces ───

def _register_surfaces(topo):
    """Register a topology's surfaces into a fresh repo on the XY plane."""
    from oversolved.kernel.query import Repository
    from oversolved.kernel.solver_registry import _register_topology_surfaces
    from oversolved.kernel.types3d import Frame3D
    repo = Repository()
    plane = Frame3D(origin=[0, 0, 0], x_axis=[1, 0, 0], y_axis=[0, 1, 0], normal=[0, 0, 1])
    _register_topology_surfaces(repo, topo, plane)
    return repo


def _strip_index(query):
    from oversolved.kernel.query import _parse_ancestry, make_ancestry_query
    ids, t = _parse_ancestry(query)
    return make_ancestry_query([i for i in ids if not i.startswith("surface:")], t)


def test_split_circle_surfaces_get_line_division_classifiers():
    from oversolved.kernel.topology import detect_topology
    topo = detect_topology(
        {"circ": {"center": [0, 0], "radius": 10.0},
         "cut": {"start": [-10, 0], "end": [10, 0]}},
        feature_id="sk1",
    )
    assert len(topo["surfaces"]) == 2
    cls = sorted(s.get("classifiers", []) for s in topo["surfaces"])
    assert cls == [["cls_ld_cut_n"], ["cls_ld_cut_p"]], cls


def test_split_surfaces_resolve_by_classifier_without_index():
    """The two half-disks share ancestry; with the positional surface:N index
    stripped they resolve only via the stable line-division classifier."""
    from oversolved.kernel.topology import detect_topology
    from oversolved.kernel.query import AmbiguousQueryError, _parse_ancestry, make_ancestry_query, _is_classifier_id
    topo = detect_topology(
        {"circ": {"center": [0, 0], "radius": 10.0},
         "cut": {"start": [-10, 0], "end": [10, 0]}},
        feature_id="sk1",
    )
    repo = _register_surfaces(topo)

    for s in topo["surfaces"]:
        q_no_index = _strip_index(s["query"])
        resolved = repo.query(q_no_index)
        assert resolved is not None, f"surface did not resolve by classifier: {q_no_index!r}"
        assert resolved.get("classifiers") == s["classifiers"]
        # Drop the classifier too -> the two half-disks are an ancestral tie.
        ids, t = _parse_ancestry(q_no_index)
        bare = make_ancestry_query([i for i in ids if not _is_classifier_id(i)], t)
        with pytest.raises(AmbiguousQueryError):
            repo.query(bare)


def test_single_region_sketch_has_no_classifiers():
    """A sketch with one surface per ancestry group is untouched (no churn)."""
    from oversolved.kernel.topology import detect_topology
    topo = detect_topology(
        {"circ": {"center": [0, 0], "radius": 5.0}}, feature_id="sk1",
    )
    assert len(topo["surfaces"]) == 1
    assert topo["surfaces"][0].get("classifiers", []) == []
    assert "@cls_" not in topo["surfaces"][0]["query"]


def test_four_quadrant_split_distinct_classifiers():
    """Two perpendicular cuts -> 4 quadrant surfaces, each with a distinct
    pair of line-division tokens (qualified per dividing line)."""
    from oversolved.kernel.topology import detect_topology
    topo = detect_topology(
        {"circ": {"center": [0, 0], "radius": 10.0},
         "h": {"start": [-10, 0], "end": [10, 0]},
         "v": {"start": [0, -10], "end": [0, 10]}},
        feature_id="sk1",
    )
    quads = [s for s in topo["surfaces"] if s.get("classifiers")]
    assert len(quads) == 4, [s["query"] for s in topo["surfaces"]]
    token_sets = {frozenset(s["classifiers"]) for s in quads}
    assert len(token_sets) == 4, token_sets  # all four quadrants distinct



# ─── circle containment is a non-problem: concentric regions have DISJOINT lineage ───

def test_concentric_circles_resolve_by_disjoint_lineage():
    """Phase 3 (circle containment) is unnecessary: a disk and the ring around it
    do NOT share ancestry. Each region is identified by its OWN bounding circle
    (disk -> the inner circle, ring -> the outer circle); the hole circle sits in
    the ring's boundary but never enters its ancestry. So the two resolve by
    distinct circle lineage with the positional surface index stripped -- there is
    no sibling tie for a containment classifier to break (unlike the line-split
    case, where the two halves genuinely share {circ, cut})."""
    from oversolved.kernel.topology import detect_topology
    topo = detect_topology(
        {"outer": {"center": [0, 0], "radius": 10.0},
         "inner": {"center": [0, 0], "radius": 4.0}},
        feature_id="sk1",
    )
    assert len(topo["surfaces"]) == 2
    # No classifier tokens are emitted for concentric circles.
    for s in topo["surfaces"]:
        assert s.get("classifiers", []) == []
        assert "@cls_" not in s["query"]

    # Ancestry is disjoint, so each region resolves uniquely even index-stripped.
    repo = _register_surfaces(topo)
    seen = set()
    for s in topo["surfaces"]:
        resolved = repo.query(_strip_index(s["query"]))
        assert resolved is not None, f"region did not resolve by lineage: {s['query']!r}"
        seen.add(tuple(resolved["origin"]))
    assert len(seen) == 2, "the two concentric regions resolved to distinct elements"
