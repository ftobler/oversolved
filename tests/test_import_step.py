"""Tests for import_step feature in solver.py."""

import os
import shutil
import pytest

pytest.importorskip("OCP.gp")

from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox  # noqa: E402
from OCP.STEPControl import STEPControl_Writer, STEPControl_AsIs  # noqa: E402
from OCP.IFSelect import IFSelect_RetDone  # noqa: E402

from oversolved.geometry import step_file_to_shape, solid_to_mesh  # noqa: E402
from oversolved.solver import _solve_import_step  # noqa: E402
from oversolved.query import Repository  # noqa: E402
from oversolved.builder import build  # noqa: E402


UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "oversolved", "uploads")


@pytest.fixture
def step_cube_file(tmp_path):
    """Create a minimal 1x1x1 cube STEP file for testing."""
    box = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    writer = STEPControl_Writer()
    writer.Transfer(box, STEPControl_AsIs)
    path = str(tmp_path / "cube.step")
    assert writer.Write(path) == IFSelect_RetDone
    return path


def _copy_to_uploads(step_cube_file):
    """Copy step file to the actual uploads dir and return the file_id."""
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    cube_name = os.path.basename(step_cube_file)
    dest = os.path.join(UPLOAD_DIR, cube_name)
    shutil.copy(step_cube_file, dest)
    return cube_name


def test_reads_cube(step_cube_file):
    """1. reads cube - tessellate; assert mesh has >= 8 vertices and >= 10 faces."""
    shape = step_file_to_shape(step_cube_file)
    mesh = solid_to_mesh(shape)
    assert len(mesh["vertices"]) >= 8
    assert len(mesh["faces"]) >= 10


def test_scale(step_cube_file):
    """2. scale - scale=2.0; all vertices in [0, 2.0] within 0.01."""
    shape = step_file_to_shape(step_cube_file, scale=2.0)
    mesh = solid_to_mesh(shape)
    for v in mesh["vertices"]:
        for coord in v:
            assert -0.01 <= coord <= 2.01, f"vertex {v} outside [0, 2]"


def test_writes_to_body_store(step_cube_file):
    """3. writes to body_store - call _solve_import_step; assert body_import1 in body_store."""
    cube_name = _copy_to_uploads(step_cube_file)

    global_repo = Repository()
    body_store = {}

    feature = {
        "id": "import1",
        "kind": "import_step",
        "file_id": cube_name,
    }

    result = _solve_import_step(feature, global_repo, body_store)
    assert result["status"] == "ok", f"Expected ok, got {result}"
    assert "body_import1" in body_store
    assert body_store["body_import1"].shape is not None


def test_builder_build_produces_mesh(step_cube_file):
    """4. builder.build produces mesh - build spec with one import_step; assert mesh in result."""
    cube_name = _copy_to_uploads(step_cube_file)

    spec = {
        "id": "test",
        "features": [
            {
                "id": "import1",
                "kind": "import_step",
                "file_id": cube_name,
            }
        ],
    }

    result = build(spec)

    assert "body_import1" in result["bodies"]
    body = result["bodies"]["body_import1"]
    assert "mesh" in body or "mesh_error" in body


def test_missing_file_id_raises():
    """5. missing file_id returns exception status."""
    global_repo = Repository()
    body_store = {}

    feature = {"id": "import1", "kind": "import_step", "file_id": ""}

    result = _solve_import_step(feature, global_repo, body_store)
    assert result["status"] == "exception"
    assert "file_id" in result["message"]


def test_file_not_found():
    """6. file not found - nonexistent file_id returns exception with 'file not found'."""
    global_repo = Repository()
    body_store = {}

    feature = {
        "id": "import1",
        "kind": "import_step",
        "file_id": "nonexistent123.step",
    }

    result = _solve_import_step(feature, global_repo, body_store)
    assert result["status"] == "exception"
    assert "file not found" in result.get("message", "")


def test_status_ok_in_result(step_cube_file):
    """7. status ok in result - build_result['result']['import1']['status'] == 'ok'."""
    cube_name = _copy_to_uploads(step_cube_file)

    spec = {
        "id": "test",
        "features": [
            {
                "id": "import1",
                "kind": "import_step",
                "file_id": cube_name,
            }
        ],
    }

    result = build(spec)
    assert result["result"]["import1"]["status"] == "ok"


def test_path_traversal_rejected():
    """8. path traversal rejected - file_id with '..' returns exception status."""
    global_repo = Repository()
    body_store = {}

    feature = {
        "id": "import1",
        "kind": "import_step",
        "file_id": "../../../etc/passwd",
    }

    result = _solve_import_step(feature, global_repo, body_store)
    assert result["status"] == "exception"
    assert "invalid file_id" in result.get("message", "")


def test_partial_rebuild_reuses_body(step_cube_file, monkeypatch):
    """9. partial rebuild reuses body - build twice with same spec; step_file_to_shape called once."""
    from oversolved import geometry

    cube_name = _copy_to_uploads(step_cube_file)

    call_count = 0
    original = geometry.step_file_to_shape

    def counting_step_file_to_shape(filepath, scale=1.0):
        nonlocal call_count
        call_count += 1
        return original(filepath, scale)

    monkeypatch.setattr(geometry, "step_file_to_shape", counting_step_file_to_shape)

    spec_v1 = {
        "id": "test",
        "features": [
            {
                "id": "import1",
                "kind": "import_step",
                "label": "Imported Part",
                "file_id": cube_name,
            }
        ],
    }

    result1 = build(spec_v1)
    assert "body_import1" in result1["bodies"]
    assert call_count == 1, f"Expected 1 call, got {call_count}"

    prev_state = result1["_build_state"]
    build(spec_v1, prev_state=prev_state)
    assert call_count == 1, f"Expected still 1 call after rebuild, got {call_count}"
