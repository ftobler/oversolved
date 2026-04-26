import pytest
from oversolved.builder import build
from solver_helpers import rect_sketch_spec, extrude_spec


def _extrude_doc(w=10, h=10, depth=5):
    """Minimal doc with one box body at origin."""
    sk = rect_sketch_spec(w, h, sketch_id="sk1")
    ex = extrude_spec("sk1", "ex1", depth)
    return {"features": [sk, ex]}


def test_transform_translate_creates_new_body():
    doc = _extrude_doc()
    doc["features"].append({
        "id": "tr1", "kind": "transform",
        "transform": {"body": "@body_ex1", "translation": [20, 0, 0], "operation": "new"},
    })
    r = build(doc)
    assert r["result"]["tr1"]["status"] == "ok"
    assert r["result"]["tr1"]["operation"] == "new"
    bid = r["result"]["tr1"]["body_id"]
    verts = r["bodies"][bid]["mesh"]["vertices"]
    xs = [v[0] for v in verts]
    assert min(xs) >= 20 - 1e-3  # box shifted right by 20


def test_transform_translate_source_body_unchanged():
    doc = _extrude_doc()
    doc["features"].append({
        "id": "tr1", "kind": "transform",
        "transform": {"body": "@body_ex1", "translation": [20, 0, 0], "operation": "new"},
    })
    r = build(doc)
    src_verts = r["bodies"]["body_ex1"]["mesh"]["vertices"]
    xs = [v[0] for v in src_verts]
    # Original box stays near origin (10x10 box starting at 0)
    assert max(xs) <= 10 + 1e-3


def test_transform_replace_mutates_body():
    doc = _extrude_doc()
    doc["features"].append({
        "id": "tr1", "kind": "transform",
        "transform": {"body": "@body_ex1", "translation": [20, 0, 0], "operation": "replace"},
    })
    r = build(doc)
    assert r["result"]["tr1"]["operation"] == "replace"
    verts = r["bodies"]["body_ex1"]["mesh"]["vertices"]
    xs = [v[0] for v in verts]
    assert min(xs) >= 20 - 1e-3


def test_transform_rotation():
    doc = _extrude_doc(w=10, h=10, depth=5)
    # Rotate 90 degrees around Z axis (world Z, origin 0,0,0)
    doc["features"].append({
        "id": "tr1", "kind": "transform",
        "transform": {
            "body": "@body_ex1",
            "rotation_axis_direction": [0, 0, 1],
            "rotation_axis_origin": [0, 0, 0],
            "rotation_angle": 90,
            "operation": "new",
        },
    })
    r = build(doc)
    assert r["result"]["tr1"]["status"] == "ok"
    bid = r["result"]["tr1"]["body_id"]
    verts = r["bodies"][bid]["mesh"]["vertices"]
    xs = [v[0] for v in verts]
    ys = [v[1] for v in verts]
    assert max(xs) == pytest.approx(0, abs=0.5)
    assert max(ys) == pytest.approx(10, abs=0.5)


def test_transform_scale():
    doc = _extrude_doc(w=10, h=10, depth=5)
    doc["features"].append({
        "id": "tr1", "kind": "transform",
        "transform": {
            "body": "@body_ex1",
            "scale": 2.0,
            "scale_center": [0, 0, 0],
            "operation": "new",
        },
    })
    r = build(doc)
    bid = r["result"]["tr1"]["body_id"]
    verts = r["bodies"][bid]["mesh"]["vertices"]
    xs = [v[0] for v in verts]
    # Scaled 2x: original 10-wide box becomes 20-wide
    assert max(xs) == pytest.approx(20, abs=0.5)


def test_transform_missing_body_returns_exception():
    doc = {"features": [{"id": "tr1", "kind": "transform", "transform": {"body": "@body_missing"}}]}
    r = build(doc)
    assert r["result"]["tr1"]["status"] == "exception"


def test_transform_identity_does_not_crash():
    doc = _extrude_doc()
    doc["features"].append({
        "id": "tr1", "kind": "transform",
        "transform": {"body": "@body_ex1"},  # all defaults: no-op
    })
    r = build(doc)
    assert r["result"]["tr1"]["status"] == "ok"
