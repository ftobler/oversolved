"""Generate reference _solve_import_step output for the TS import leaf gate (phase 2f).

Exports a box to STEP, base64-encodes it, runs the real `_solve_import_step` at
scale 1 and scale 2, and records the embedded STEP data + result dict + imported
body volume. Writes `frontend/src/kernel/occ/__fixtures__/importStep.json`. The
gated test (importStepReal.test.ts) feeds the same base64 through the TS leaf
(emscripten-FS STEP read) and asserts result + volume. STEP *export* stays
Python/phase-3 side; only the read path is exercised in TS.

Run: .venv/bin/python tests/wasm_harness/gen_importstep_fixture.py
"""

import base64
import json
import os
import tempfile

from oversolved.kernel.query import Repository
from oversolved.kernel.cadquery_ops import _ensure_occ
from oversolved.kernel.geometry_io import shape_to_step_file
from oversolved.kernel.solver_features_import import _solve_import_step
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp


def _volume(shape) -> float:
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(_ensure_occ(shape), props, True, False, False)
    return props.Mass()


def _box_step_b64() -> str:
    box = BRepPrimAPI_MakeBox(8.0, 8.0, 8.0).Shape()
    with tempfile.NamedTemporaryFile(suffix=".step", delete=False) as f:
        path = f.name
    try:
        shape_to_step_file(box, path)
        with open(path, "rb") as fh:
            return base64.b64encode(fh.read()).decode()
    finally:
        os.unlink(path)


def _case(name, file_data, scale, feature_id):
    body_store: dict = {}
    feature = {"id": feature_id, "file_data": file_data, "scale": scale}
    result = _solve_import_step(feature, Repository(), body_store)
    return {
        "name": name,
        "scale": scale,
        "feature_id": feature_id,
        "result": result,
        "volume": _volume(body_store[result["body_id"]].shape),
    }


def main():
    file_data = _box_step_b64()
    cases = [
        _case("scale1", file_data, 1.0, "imp1"),
        _case("scale2", file_data, 2.0, "imp2"),
    ]
    fixture = {"file_data": file_data, "cases": cases}
    here = os.path.dirname(__file__)
    out_dir = os.path.abspath(
        os.path.join(here, "..", "..", "frontend", "src", "kernel", "occ", "__fixtures__")
    )
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "importStep.json")
    with open(out_path, "w") as f:
        json.dump(fixture, f, indent=2)
    print(f"wrote {out_path} ({len(cases)} cases, step b64 {len(file_data)} chars)")
    for c in cases:
        print(f"  {c['name']}: result={c['result']}, vol={c['volume']:.3f}")


if __name__ == "__main__":
    main()
