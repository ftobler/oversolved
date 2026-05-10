"""Tests for BuildIsolator — WebSocket relay to solver daemon."""

import importlib
import multiprocessing as mp
import socket
import time
from typing import Generator
import pytest

pytestmark = [
    pytest.mark.skipif(
        not importlib.util.find_spec("cadquery"), reason="cadquery not installed"
    ),
    pytest.mark.skipif(
        not importlib.util.find_spec("vtkmodules"), reason="vtkmodules not installed"
    ),
]


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _run_daemon(port: int) -> None:
    import asyncio
    from oversolved.solver_daemon import main_async
    asyncio.run(main_async("127.0.0.1", port, 60.0))


@pytest.fixture(scope="module")
def daemon_port() -> Generator[int, None, None]:
    port = _find_free_port()
    ctx = mp.get_context("spawn")
    proc = ctx.Process(target=_run_daemon, args=(port,))
    proc.start()
    time.sleep(1.5)
    yield port
    proc.terminate()
    proc.join(5)


def test_build_isolated_basic(daemon_port):
    """BuildIsolator should produce the same result as direct build()."""
    from oversolved.kernel.build_isolated import BuildIsolator
    from solver_helpers import full_rect_extrude_spec

    spec = full_rect_extrude_spec(w=10, h=10, d=5)

    isolator = BuildIsolator(host="127.0.0.1", port=daemon_port, timeout=30)
    try:
        result = isolator.build(spec)
    finally:
        isolator.shutdown()

    assert "bodies" in result
    assert "result" in result
    assert "body_ex1" in result["bodies"]
    assert result["result"]["ex1"]["status"] == "ok"
    mesh = result["bodies"]["body_ex1"]["mesh"]
    assert len(mesh["vertices"]) > 0
    assert len(mesh["faces"]) > 0
    # _build_state should NOT be in the result
    assert "_build_state" not in result


def test_build_isolated_incremental(daemon_port):
    """Two sequential builds with the same doc_id should reuse prev_state."""
    from oversolved.kernel.build_isolated import BuildIsolator
    from solver_helpers import full_rect_extrude_spec

    spec = full_rect_extrude_spec(w=10, h=10, d=5)

    isolator = BuildIsolator(host="127.0.0.1", port=daemon_port, timeout=30)
    try:
        r1 = isolator.build(spec, doc_id="doc-1")
        assert r1["result"]["ex1"]["status"] == "ok"

        # Second build with the same doc_id adds a fillet.
        spec["features"].append({
            "id": "fillet1",
            "kind": "fillet",
            "edges": ["?body_ex1:edge:0"],
            "radius": 1.0,
        })
        r2 = isolator.build(spec, doc_id="doc-1")
        assert r2["result"]["fillet1"]["status"] == "ok"
    finally:
        isolator.shutdown()


def test_build_isolated_clear_cache(daemon_port):
    """clear_cache() should force a full rebuild."""
    from oversolved.kernel.build_isolated import BuildIsolator
    from solver_helpers import full_rect_extrude_spec

    spec = full_rect_extrude_spec(w=10, h=10, d=5)

    isolator = BuildIsolator(host="127.0.0.1", port=daemon_port, timeout=30)
    try:
        r1 = isolator.build(spec, doc_id="doc-2")
        assert r1["result"]["ex1"]["status"] == "ok"

        isolator.clear_cache(doc_id="doc-2")

        r2 = isolator.build(spec, doc_id="doc-2")
        assert r2["result"]["ex1"]["status"] == "ok"
    finally:
        isolator.shutdown()


def test_memcache_incremental_reuses_state(daemon_port):
    """Incremental builds with the same doc_id must succeed — proving
    prev_state is correctly maintained inside the worker.

    If the cache were stale or corrupted, the incremental build would
    fail because builder's dirty-detection expects a valid prev_state
    for features it skips.
    """
    from oversolved.kernel.build_isolated import BuildIsolator
    from solver_helpers import rect_sketch_spec, extrude_spec

    isolator = BuildIsolator(host="127.0.0.1", port=daemon_port, timeout=30)
    try:
        # Build a base spec with enough features that skipping them
        # would break if the cache were wrong.
        spec: dict = {
            "features": [
                rect_sketch_spec(w=10, h=10, sketch_id="sk1"),
                extrude_spec("sk1", "ex1", 5),
            ]
        }
        # First build seeds the cache.
        r1 = isolator.build(spec, doc_id="cache-perf")
        assert r1["result"]["ex1"]["status"] == "ok"

        # Incremental: add a fillet.  Must use the cached prev_state.
        spec["features"].append({
            "id": "fillet1", "kind": "fillet",
            "edges": ["?body_ex1:edge:0"], "radius": 1.0,
        })
        r2 = isolator.build(spec, doc_id="cache-perf")
        assert r2["result"]["fillet1"]["status"] == "ok", \
            f"incremental fillet failed: {r2['result']['fillet1']}"

        # Incremental again: add another fillet on a different edge.
        spec["features"].append({
            "id": "fillet2", "kind": "fillet",
            "edges": ["?body_ex1:edge:1"], "radius": 0.5,
        })
        r3 = isolator.build(spec, doc_id="cache-perf")
        assert r3["result"]["fillet2"]["status"] == "ok", \
            f"second incremental fillet failed: {r3['result']['fillet2']}"

        # After clearing the cache, a build with the same spec must
        # still succeed (full rebuild path).
        isolator.clear_cache(doc_id="cache-perf")
        r4 = isolator.build(spec, doc_id="cache-perf")
        assert r4["result"]["fillet2"]["status"] == "ok", \
            f"post-clear rebuild failed: {r4['result']['fillet2']}"
    finally:
        isolator.shutdown()


def test_memcache_incremental_same_result(daemon_port):
    """Incremental and full rebuild must produce identical geometry for
    the same spec — memcache must not affect correctness."""
    from oversolved.kernel.build_isolated import BuildIsolator
    from solver_helpers import rect_sketch_spec, extrude_spec

    spec: dict = {
        "features": [
            rect_sketch_spec(w=10, h=10, sketch_id="sk1"),
            extrude_spec("sk1", "ex1", 5),
            {"id": "fillet1", "kind": "fillet",
             "edges": ["?body_ex1:edge:0"], "radius": 1.0},
        ]
    }

    isolator = BuildIsolator(host="127.0.0.1", port=daemon_port, timeout=30)
    try:
        # Full rebuild (no prior cache for this doc_id).
        r_full = isolator.build(spec, doc_id="memcache-correct-1")
        verts_full = len(r_full["bodies"]["body_ex1"]["mesh"]["vertices"])

        # Clear and rebuild — should give the same result.
        isolator.clear_cache(doc_id="memcache-correct-1")
        r_full2 = isolator.build(spec, doc_id="memcache-correct-1")
        verts_full2 = len(r_full2["bodies"]["body_ex1"]["mesh"]["vertices"])
        assert verts_full2 == verts_full, \
            "second full rebuild differs from first"

        # Now build incrementally: first just extrude, then add fillet.
        spec_base: dict = {
            "features": [
                rect_sketch_spec(w=10, h=10, sketch_id="sk1"),
                extrude_spec("sk1", "ex1", 5),
            ]
        }
        r_base = isolator.build(spec_base, doc_id="memcache-correct-2")
        assert r_base["result"]["ex1"]["status"] == "ok"

        spec_base["features"].append({
            "id": "fillet1", "kind": "fillet",
            "edges": ["?body_ex1:edge:0"], "radius": 1.0,
        })
        r_incr = isolator.build(spec_base, doc_id="memcache-correct-2")
        assert r_incr["result"]["fillet1"]["status"] == "ok", \
            f"incremental fillet failed: {r_incr['result']['fillet1']}"
        verts_incr = len(r_incr["bodies"]["body_ex1"]["mesh"]["vertices"])

        # Incremental must produce the same vertex count as full rebuild.
        assert verts_incr == verts_full, \
            f"incremental ({verts_incr} verts) != full ({verts_full} verts)"
    finally:
        isolator.shutdown()


def test_memcache_cross_doc_isolation(daemon_port):
    """Different doc_ids must have independent caches."""
    from oversolved.kernel.build_isolated import BuildIsolator
    from solver_helpers import full_rect_extrude_spec

    isolator = BuildIsolator(host="127.0.0.1", port=daemon_port, timeout=30)
    try:
        spec_a = full_rect_extrude_spec(w=10, h=10, d=5)
        spec_b = full_rect_extrude_spec(w=8, h=8, d=3)

        # Populate cache for doc-a.
        r_a1 = isolator.build(spec_a, doc_id="doc-a")
        t_a1 = r_a1.get("solve_ms", 0)

        # First build for doc-b — should be a full rebuild (not affected
        # by doc-a cache).
        r_b1 = isolator.build(spec_b, doc_id="doc-b")
        t_b1 = r_b1.get("solve_ms", 0)
        assert r_b1["result"]["ex1"]["status"] == "ok"

        # Second build for doc-a — should be fast (cache hit).
        r_a2 = isolator.build(spec_a, doc_id="doc-a")
        t_a2 = r_a2.get("solve_ms", 0)

        # doc-a's second build should be fast, doc-b's first should be
        # a full build (no cross-contamination).
        assert t_a2 <= t_a1, \
            f"doc-a incremental ({t_a2}ms) should be <= first ({t_a1}ms)"
        # doc-b first build should be comparable to doc-a's first build
        # (both are full rebuilds on a fresh cache).
        assert t_b1 > 0, "doc-b first build should take measurable time"
    finally:
        isolator.shutdown()


def test_build_isolated_preserves_error(daemon_port):
    """Errors from build() should be propagated, not crash the server."""
    from oversolved.kernel.build_isolated import BuildIsolator
    from solver_helpers import full_rect_extrude_spec

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    spec["features"].append({
        "id": "bad_fillet",
        "kind": "fillet",
        "edges": [],
        "radius": 1.0,
    })

    isolator = BuildIsolator(host="127.0.0.1", port=daemon_port, timeout=30)
    try:
        result = isolator.build(spec)
    finally:
        isolator.shutdown()

    # Should get a normal result structure, even with error
    assert "result" in result
    # The error is on the specific feature
    assert result["result"]["bad_fillet"]["status"] == "exception"


def test_build_isolated_fillet_chain_no_crash(daemon_port):
    """Extrude -> fillet -> revolves -> fillet with stale query should not crash."""
    from oversolved.kernel.build_isolated import BuildIsolator
    from solver_helpers import rect_sketch_spec, extrude_spec

    w, h, d = 10.0, 10.0, 5.0

    # Build the base shape
    spec = {
        "features": [
            rect_sketch_spec(w=w, h=h, sketch_id="sk1"),
            extrude_spec("sk1", "ex1", d),
        ]
    }
    isolator = BuildIsolator(host="127.0.0.1", port=daemon_port, timeout=30)
    try:
        r0 = isolator.build(spec, doc_id="crash-test")
        eq0 = r0["bodies"]["body_ex1"].get("edge_queries", [])

        # Add fillet 1
        spec["features"].append({
            "id": "fillet1",
            "kind": "fillet",
            "edges": ["?body_ex1:edge:3"],
            "radius": 1.0,
        })
        _r1 = isolator.build(spec, doc_id="crash-test")
        assert _r1["result"]["fillet1"]["status"] == "ok"

        # Add revolves
        rev_sk = rect_sketch_spec(w=3.0, h=2.0, sketch_id="rev_sk1")
        for key in rev_sk["initial"]:
            rev_sk["initial"][key] = [
                rev_sk["initial"][key][0] + 5.0,
                rev_sk["initial"][key][1],
                rev_sk["initial"][key][2] + 5.0,
                rev_sk["initial"][key][3],
            ]
        rev_sk["plane"] = "@builtin_plane_right"
        spec["features"].append(rev_sk)
        spec["features"].append({
            "id": "rev1", "kind": "revolve", "sketch": "$rev_sk1",
            "angle": 45, "axis_origin": [5, 0, 0], "axis_direction": [0, 0, 1],
            "direction": "reverse", "operation": "add",
        })
        _r2 = isolator.build(spec, doc_id="crash-test")
        assert _r2["result"]["rev1"]["status"] == "ok"

        # Second fillet with a stale hash query from eq0
        stale = eq0[5] if len(eq0) > 5 else eq0[0]
        spec["features"].append({
            "id": "fillet2",
            "kind": "fillet",
            "edges": [stale],
            "radius": 1.0,
        })
        r3 = isolator.build(spec, doc_id="crash-test")

        # The result should be either ok or exception, never a crash
        status = r3["result"]["fillet2"]["status"]
        assert status in ("ok", "exception"), f"Unexpected status: {status}"
    finally:
        isolator.shutdown()
