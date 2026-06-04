"""CLI entrypoint: run the Python kernel on JSON fixture specs.

Reads a JSON array of test entries from stdin (or a file path argument).  Each
entry has a ``spec`` key (the PartDoc dict) and an optional ``label``.  Runs
``build()`` on each spec, sanitises the output (strips ``solve_ms`` and OCC
handles that vary across runs), and writes the resulting regression data to
stdout as JSON.

Usage examples::

  python tests/wasm_harness/run_kernel.py < fixtures.json
  python tests/wasm_harness/run_kernel.py fixtures.json

Output schema
-------------

.. code-block:: json

  [
    {
      "label": "box_extrude_5x5x5",
      "ok": true,
      "error": null,
      "result": {
        "sk1": {"status": "fully_constrained", ...},
        "extrude1": {"status": "ok", ...}
      },
      "bodies": {
        "body_extrude1": {
          "mesh": {"vertices": [[0,0,0],...], "faces": [[0,1,2],...]},
          "edge_count": 12,
          "face_count": 6,
          "face_hashes": ["gh_f_...", ...],
          "edge_hashes": ["gh_e_...", ...]
        }
      }
    }
  ]
"""

from __future__ import annotations

import json
import sys
import traceback
from typing import Any

from oversolved.kernel.builder import build


def _sanitise_mesh(mesh: dict[str, Any]) -> dict[str, Any]:
    """Keep only the structural mesh fields needed for cross-kernel diffing."""
    return {
        "vertices": mesh.get("vertices", []),
        "faces": mesh.get("faces", []),
    }


def _extract_face_hashes(body: dict[str, Any]) -> list[str]:
    """Extract face geometry hashes from body output (centroid + normal)."""
    mesh = body.get("mesh", {})
    face_data = mesh.get("face_data", [])
    from oversolved.kernel.geom_hash import face_geometry_hash
    hashes: list[str] = []
    for fd in face_data:
        centroid = fd.get("centroid", [])
        normal = fd.get("normal", [])
        if centroid and normal:
            try:
                hashes.append(face_geometry_hash(list(centroid), list(normal)))
            except Exception:
                hashes.append("hash_error")
    return sorted(hashes)


def _extract_edge_hashes(body: dict[str, Any]) -> list[str]:
    """Extract edge geometry hashes from body output."""
    edges = body.get("edges", [])
    from oversolved.kernel.geom_hash import edge_geometry_hash
    hashes: list[str] = []
    for ed in edges:
        try:
            hashes.append(edge_geometry_hash(ed))
        except Exception:
            hashes.append("hash_error")
    return sorted(hashes)


def _sanitise_body(body: dict[str, Any]) -> dict[str, Any]:
    """Keep only the body fields needed for cross-kernel regression diffing."""
    mesh = body.get("mesh", {})
    sanitised: dict[str, Any] = {
        "id": body.get("id", ""),
        "created_by": body.get("created_by", ""),
        "modified_by": body.get("modified_by", [])[:],
        "mesh": _sanitise_mesh(mesh) if mesh else {"vertices": [], "faces": []},
        "face_count": len(mesh.get("face_data", [])),
        "edge_count": len(body.get("edges", [])),
        "face_hashes": _extract_face_hashes(body),
        "edge_hashes": _extract_edge_hashes(body),
    }
    if body.get("mesh_error"):
        sanitised["mesh_error"] = body["mesh_error"]
    return sanitised


def _sanitise_result(_feature_id: str, feature_result: dict[str, Any]) -> dict[str, Any]:
    """Keep only the result fields needed for diffing; strip solve_ms."""
    if not isinstance(feature_result, dict):
        return {"status": "exception", "error": str(feature_result)}

    cleaned: dict[str, Any] = {}
    for key in ("status", "geometry", "features", "plane", "exception"):
        if key in feature_result:
            cleaned[key] = feature_result[key]
    if feature_result.get("status") == "exception":
        cleaned["error"] = str(feature_result.get("exception", "unknown"))
        cleaned.pop("exception", None)
    return cleaned


def _extract_input_sketches(spec: dict[str, Any]) -> list[dict[str, Any]]:
    """Capture the solver-relevant input of each sketch feature.

    The WASM shadow harness feeds these straight to the Rust solver and diffs
    its output against this entry's Python ``result``; embedding the input here
    keeps the baseline the single source of truth (no duplicated fixtures on the
    TS side). Only fields the Rust solver consumes are kept.
    """
    sketches: list[dict[str, Any]] = []
    for feature in spec.get("features", []):
        if not isinstance(feature, dict) or feature.get("kind") != "sketch":
            continue
        sketches.append({
            "id": feature.get("id", ""),
            "plane": feature.get("plane"),
            "entities": [
                {"id": e.get("id"), "kind": e.get("kind")}
                for e in feature.get("entities", [])
            ],
            "initial": feature.get("initial", {}),
            "constraints": feature.get("constraints", []),
        })
    return sketches


def run_specs(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Run the Python kernel on each entry and return regression data."""
    results: list[dict[str, Any]] = []
    for entry in entries:
        label = entry.get("label", "unnamed")
        spec = entry.get("spec", {})
        try:
            response = build(spec)

            # Sanitise feature results
            sanitised_result: dict[str, Any] = {}
            for fid, fresult in response.get("result", {}).items():
                sanitised_result[fid] = _sanitise_result(fid, fresult)

            # Sanitise bodies
            sanitised_bodies: dict[str, Any] = {}
            for bid, body in response.get("bodies", {}).items():
                sanitised_bodies[bid] = _sanitise_body(body)

            results.append({
                "label": label,
                "ok": True,
                "error": None,
                "input_sketches": _extract_input_sketches(spec),
                "result": sanitised_result,
                "bodies": sanitised_bodies,
            })
        except Exception as exc:
            results.append({
                "label": label,
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}",
                "result": {},
                "bodies": {},
            })

    return results


def main() -> None:
    """Read JSON from stdin or a file argument, run kernel, write JSON to stdout."""
    if len(sys.argv) > 1:
        with open(sys.argv[1], "r") as f:
            data = json.load(f)
    else:
        data = json.load(sys.stdin)

    if isinstance(data, dict):
        entries = [data]
    else:
        entries = data

    results = run_specs(entries)
    json.dump(results, sys.stdout, indent=2, sort_keys=True)


if __name__ == "__main__":
    main()
