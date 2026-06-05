"""Generate behavioral parity scenarios for the TS query.ts resolver port.

Each scenario is a sequence of Repository mutations followed by queries. The
generator runs every scenario against the canonical Python `Repository` and
records the observable result of each query (resolved payload, empty, or
AmbiguousQueryError). The TS test replays the identical op sequence against the
port and asserts the same outcomes, gating cross-language resolver parity (the
phase 2c exit criterion: topology + query resolution matches Python).

Element ids are ephemeral/random in both kernels, so scenarios only assert on
payloads (structural) and error kinds, never on minted ids. The op sequence is
deterministic, so query_all result ordering is comparable.

Run: .venv/bin/python tests/wasm_harness/gen_query_fixture.py
"""

import json
import os

from oversolved.kernel.query import (
    Repository,
    AmbiguousQueryError,
    _init_global_repo,
    _evict_ancestry_and_register,
    _current_feature_id,
    make_ancestry_query,
)


def _run_query(repo, q):
    kind = q.get("kind", "query")
    try:
        if kind == "query_all":
            results = repo.query_all(q["query"], q.get("current_feature_id"))
            return {"results": results}
        result = repo.query(
            q["query"],
            q.get("context"),
            q.get("body_store"),
            q.get("current_feature_id"),
        )
        return {"result": result}
    except AmbiguousQueryError:
        return {"error": "AmbiguousQueryError"}


def _apply(repo, op):
    kind = op["op"]
    if kind == "register":
        repo.register(op["id"], op["obj"])
    elif kind == "register_ancestor":
        repo.register_ancestor(op["ancestors"], op["obj"], op.get("geom_hash"))
    elif kind == "evict_register":
        _evict_ancestry_and_register(
            repo, op["ancestors"], op["obj"], op.get("index_tag"), op.get("geom_hash")
        )
    elif kind == "gc":
        repo.gc(set(op["active_fids"]))
    elif kind == "clear_sketch":
        repo.clear_by_sketch_id(op["sketch_id"])
    else:
        raise ValueError(f"unknown op {kind}")


def _run_scenario(scn):
    repo = _init_global_repo() if scn.get("init_builtin") else Repository()
    if scn.get("feature_order") is not None:
        repo.set_feature_order(scn["feature_order"])
    token = None
    if "context_feature_id" in scn:
        token = _current_feature_id.set(scn["context_feature_id"])
    try:
        for op in scn.get("ops", []):
            _apply(repo, op)
        out_queries = []
        for q in scn["queries"]:
            out_queries.append({**q, **_run_query(repo, q)})
        return {**scn, "queries": out_queries}
    finally:
        if token is not None:
            _current_feature_id.reset(token)


# ─── Scenarios ───


def _scenarios():
    scns = []

    # 1. exact subset match -> single element
    scns.append({
        "name": "exact_subset_single",
        "ops": [
            {"op": "register_ancestor", "ancestors": ["@feat_a", "edge:0", "@body_x"],
             "obj": {"type": "edge", "tag": "the-edge"}},
        ],
        "queries": [
            {"query": make_ancestry_query(["@feat_a", "@body_x"])},
            {"query": make_ancestry_query(["@feat_a", "@body_x", "edge:0"], "edge")},
            {"query": make_ancestry_query(["@nope"])},
        ],
    })

    # 2. exact subset match -> ambiguous
    scns.append({
        "name": "exact_subset_ambiguous",
        "ops": [
            {"op": "register_ancestor", "ancestors": ["@feat_a", "surface:0"],
             "obj": {"type": "flatface", "tag": "f0"}},
            {"op": "register_ancestor", "ancestors": ["@feat_a", "surface:1"],
             "obj": {"type": "flatface", "tag": "f1"}},
        ],
        "queries": [
            {"query": make_ancestry_query(["@feat_a"])},
            {"query": make_ancestry_query(["@feat_a", "surface:1"], "flatface")},
        ],
    })

    # 3. type restriction with subtype (flatface is-a face)
    scns.append({
        "name": "type_restriction_subtype",
        "ops": [
            {"op": "register_ancestor", "ancestors": ["@feat_a", "surface:0"],
             "obj": {"type": "flatface", "tag": "ff"}},
        ],
        "queries": [
            {"query": make_ancestry_query(["@feat_a", "surface:0"], "face")},
            {"query": make_ancestry_query(["@feat_a", "surface:0"], "vertex")},
        ],
    })

    # 4. coercion upward to solid via body_store
    body = {"type": "solid", "body_id": "body_x", "tag": "the-solid"}
    scns.append({
        "name": "coerce_to_solid",
        "ops": [
            {"op": "register_ancestor",
             "ancestors": ["@feat_a", "surface:0"],
             "obj": {"type": "flatface", "body_id": "body_x", "created_by": "feat_a"}},
        ],
        "queries": [
            {"query": make_ancestry_query(["@feat_a", "surface:0"], "solid"),
             "body_store": {"body_x": body}},
        ],
    })

    # 5. coercion ambiguous -> two distinct solids
    body_x = {"type": "solid", "body_id": "body_x"}
    body_y = {"type": "solid", "body_id": "body_y"}
    scns.append({
        "name": "coerce_ambiguous",
        "ops": [
            {"op": "register_ancestor", "ancestors": ["@feat_a"],
             "obj": {"type": "flatface", "body_id": "body_x", "created_by": "feat_a"}},
            {"op": "register_ancestor", "ancestors": ["@feat_a"],
             "obj": {"type": "flatface", "body_id": "body_y", "created_by": "feat_a"}},
        ],
        "queries": [
            {"query": make_ancestry_query(["@feat_a"], "solid"),
             "body_store": {"body_x": body_x, "body_y": body_y}},
        ],
    })

    # 6. classifier narrowing
    scns.append({
        "name": "classifier_narrowing",
        "ops": [
            {"op": "register_ancestor", "ancestors": ["@feat_a", "surface:0"],
             "obj": {"type": "flatface", "tag": "top", "classifiers": ["cls_zp"]}},
            {"op": "register_ancestor", "ancestors": ["@feat_a", "surface:1"],
             "obj": {"type": "flatface", "tag": "bot", "classifiers": ["cls_zn"]}},
        ],
        "queries": [
            {"query": make_ancestry_query(["@feat_a", "@cls_zp"], "flatface")},
            {"query": make_ancestry_query(["@feat_a", "@cls_zn"], "flatface")},
        ],
    })

    # 7. geom-hash tie-break (precise then gnormal)
    scns.append({
        "name": "geom_hash_tiebreak",
        "ops": [
            {"op": "register_ancestor", "ancestors": ["@feat_a", "surface:0"],
             "obj": {"type": "flatface", "tag": "A"}, "geom_hash": "gface_aaaa"},
            {"op": "register_ancestor", "ancestors": ["@feat_a", "surface:1"],
             "obj": {"type": "flatface", "tag": "B"}, "geom_hash": "gface_bbbb"},
        ],
        "queries": [
            {"query": make_ancestry_query(["@feat_a", "@gface_bbbb"], "flatface")},
            {"query": make_ancestry_query(["@gface_aaaa"], "flatface")},  # hash-only fallback
        ],
    })

    # 8. partial ancestral match (registered key is a subset of the query set)
    scns.append({
        "name": "partial_ancestral",
        "ops": [
            {"op": "register_ancestor", "ancestors": ["@feat_a"],
             "obj": {"type": "flatface", "tag": "only"}},
        ],
        "queries": [
            {"query": make_ancestry_query(["@feat_a", "@feat_b", "surface:3"], "flatface")},
        ],
    })

    # 9. ordering guard: feat_c (idx 2) cannot see feat_b's (idx 1) element when
    #    resolving as feat_a (idx 0)
    scns.append({
        "name": "ordering_guard",
        "feature_order": ["feat_a", "feat_b"],
        "ops": [
            {"op": "register_ancestor", "ancestors": ["@shared"],
             "obj": {"type": "flatface", "tag": "from_a", "created_by": "feat_a"}},
            {"op": "register_ancestor", "ancestors": ["@shared"],
             "obj": {"type": "flatface", "tag": "from_b", "created_by": "feat_b"}},
        ],
        "queries": [
            # As feat_a: only from_a is visible (from_b is ordered later) -> single
            {"query": make_ancestry_query(["@shared"], "flatface"), "current_feature_id": "feat_a"},
            # As feat_b: both visible -> ambiguous
            {"query": make_ancestry_query(["@shared"], "flatface"), "current_feature_id": "feat_b"},
        ],
    })

    # 10. query_all enumerates the matching set in registration order
    scns.append({
        "name": "query_all",
        "ops": [
            {"op": "register_ancestor", "ancestors": ["@feat_a", "surface:0"],
             "obj": {"type": "flatface", "tag": "f0"}},
            {"op": "register_ancestor", "ancestors": ["@feat_a", "surface:1"],
             "obj": {"type": "flatface", "tag": "f1"}},
            {"op": "register_ancestor", "ancestors": ["@feat_a", "edge:0"],
             "obj": {"type": "straightedge", "tag": "e0"}},
        ],
        "queries": [
            {"query": make_ancestry_query(["@feat_a"], "flatface"), "kind": "query_all"},
            {"query": make_ancestry_query(["@feat_a"]), "kind": "query_all"},
            {"query": make_ancestry_query(["@feat_a"], "straightedge"), "kind": "query_all"},
        ],
    })

    # 11. gc evicts feature-owned entries whose refs all left active set
    scns.append({
        "name": "gc_eviction",
        "ops": [
            {"op": "register_ancestor", "ancestors": ["@feat_a", "surface:0"],
             "obj": {"type": "flatface", "tag": "keep"}},
            {"op": "register_ancestor", "ancestors": ["@feat_b", "surface:0"],
             "obj": {"type": "flatface", "tag": "drop"}},
            {"op": "gc", "active_fids": ["feat_a"]},
        ],
        "queries": [
            {"query": make_ancestry_query(["@feat_a", "surface:0"], "flatface")},
            {"query": make_ancestry_query(["@feat_b", "surface:0"], "flatface")},
        ],
    })

    # 12. evict + re-register by index_tag replaces the stale positional entry
    scns.append({
        "name": "evict_register_index_tag",
        "ops": [
            {"op": "register_ancestor", "ancestors": ["@feat_a", "surface:0", "stale_geom"],
             "obj": {"type": "flatface", "tag": "stale"}},
            {"op": "evict_register", "ancestors": ["@feat_a", "surface:0", "fresh_geom"],
             "obj": {"type": "flatface", "tag": "fresh"}, "index_tag": "surface:0"},
        ],
        "queries": [
            {"query": make_ancestry_query(["@feat_a", "surface:0"], "flatface")},
        ],
    })

    # 13. builtin global repo: absolute + local resolution
    scns.append({
        "name": "builtin_and_direct",
        "init_builtin": True,
        "ops": [
            {"op": "register", "id": "feat_a/e0", "obj": {"type": "line", "tag": "abs"}},
            {"op": "register", "id": "ctx_e0", "obj": {"type": "line", "tag": "loc"}},
        ],
        "queries": [
            {"query": "@builtin_plane_front"},
            {"query": "@builtin_origin"},
            {"query": "@feat_a/e0"},
            {"query": "$e0", "context": "ctx_"},
            {"query": "$e0"},  # no context -> None
            {"query": ""},
        ],
    })

    return scns


def main():
    fixture = [_run_scenario(s) for s in _scenarios()]
    here = os.path.dirname(__file__)
    out_dir = os.path.abspath(
        os.path.join(here, "..", "..", "frontend", "src", "kernel", "occ", "__fixtures__")
    )
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "queryScenarios.json")
    with open(out_path, "w") as f:
        json.dump(fixture, f, indent=2)
    print(f"wrote {out_path} ({len(fixture)} scenarios)")


if __name__ == "__main__":
    main()
