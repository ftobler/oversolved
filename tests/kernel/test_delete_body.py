import importlib
import pytest

from oversolved.kernel.builder import build
from solver_helpers import rect_sketch_spec, extrude_spec

pytestmark = pytest.mark.skipif(
    not importlib.util.find_spec("vtkmodules"), reason="vtkmodules not installed"
)


def _extrude_doc():
    sk = rect_sketch_spec(10, 10, sketch_id="sk1")
    ex = extrude_spec("sk1", "ex1", 5)
    return {"features": [sk, ex]}


def test_delete_body_removes_body_from_output():
    doc = _extrude_doc()
    doc["features"].append({
        "id": "db1", "kind": "delete_body",
        "delete_body": {"body": "@body_ex1"},
    })
    r = build(doc)
    assert r["result"]["db1"]["status"] == "ok"
    assert r["result"]["db1"]["deleted_body_id"] == "body_ex1"
    assert "body_ex1" not in r["bodies"]


def test_delete_body_missing_body_returns_exception():
    doc = {"features": [
        {"id": "db1", "kind": "delete_body", "delete_body": {"body": "@body_missing"}},
    ]}
    r = build(doc)
    assert r["result"]["db1"]["status"] == "exception"


def test_delete_body_resolves_feature_id_to_body():
    doc = _extrude_doc()
    doc["features"].append({
        "id": "db1", "kind": "delete_body",
        "delete_body": {"body": "@ex1"},
    })
    r = build(doc)
    assert r["result"]["db1"]["status"] == "ok"
    assert r["result"]["db1"]["deleted_body_id"] == "body_ex1"
    assert "body_ex1" not in r["bodies"]


def test_delete_body_two_bodies_only_removes_target():
    sk1 = rect_sketch_spec(10, 10, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", 5)
    doc = {"features": [sk1, ex1]}
    r = build(doc)
    assert "body_ex1" in r["bodies"]
    doc["features"].append({
        "id": "db1", "kind": "delete_body",
        "delete_body": {"body": "@body_ex1"},
    })
    r = build(doc)
    assert "body_ex1" not in r["bodies"]


def test_delete_body_body_target_change_triggers_rebuild():
    """Changing the body ref in delete_body must be detected as dirty."""
    doc = _extrude_doc()
    doc["features"].append({
        "id": "db1", "kind": "delete_body",
        "delete_body": {"body": "@body_ex1"},
    })
    r1 = build(doc)
    assert r1["result"]["db1"]["status"] == "ok"
    assert "body_ex1" not in r1["bodies"]

    doc["features"][-1] = {
        "id": "db1", "kind": "delete_body",
        "delete_body": {"body": "@body_nonexistent"},
    }
    r2 = build(doc, prev_state=r1["_build_state"])
    assert r2["result"]["db1"]["status"] == "exception"
    assert r2["bodies"].get("body_ex1") is not None


def test_delete_body_with_extrude_integration():
    """Full feature stack: sketch -> extrude -> delete_body. Body absent from output."""
    sk = rect_sketch_spec(10, 10, sketch_id="sk1")
    ex = extrude_spec("sk1", "ex1", 5)
    doc = {"features": [sk, ex]}
    r1 = build(doc)
    assert "body_ex1" in r1["bodies"]

    doc["features"].append({
        "id": "db1", "kind": "delete_body",
        "delete_body": {"body": "@body_ex1"},
    })
    r2 = build(doc)
    assert "body_ex1" not in r2["bodies"]


def test_delete_body_uses_ancestry_coercion():
    doc = _extrude_doc()
    doc["features"].append({
        "id": "db1", "kind": "delete_body",
        "delete_body": {"body": "?4;@ex1:solid"},
    })
    r = build(doc)
    assert r["result"]["db1"]["status"] == "ok"
    assert r["result"]["db1"]["deleted_body_id"] == "body_ex1"
    assert "body_ex1" not in r["bodies"]
