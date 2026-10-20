#!/usr/bin/env python3
"""Run a CadQuery script and write a translation reference.json.

CadQuery is the first translation source: its workplane / sketch / extrude /
fillet API maps closely onto Oversolved features, and it wraps the same OCCT
kernel family, so measures should agree tightly. This runner executes the
source script rather than having a model interpret the Python, so the
reference is exactly what the other tool built.

The emitted reference uses the translation corpus format:

    { source: { tool, version, file }, tolerance: { rel, abs },
      topology: "report" | "strict", bodies, volume, area, centroid, bbox,
      faces?, edges? }

`bbox` is six exact numbers from `Shape.BoundingBox()`, the same AddOptimal box
`frontend/src/kernel/occ/measure.ts` reads. A script must assign its finished
workplane or shape to `result` (or `model` / `part`).

CadQuery is an optional extra (`pip install -e ".[dev,cadquery]"`), imported
only inside `main` so mypy, ruff and the gates run without the OCP wheel. The
committed reference.json is what CI compares against; CI never imports CadQuery.

Run from the repo root:

    .venv/bin/python frontend/scripts/cadqueryReference.py \
        frontend/translations/02-box-fillet-vertical/source.py \
        --out frontend/translations/02-box-fillet-vertical/reference.json
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import pathlib
import sys
from typing import Any

DEFAULT_REL = 1e-5
DEFAULT_ABS = 1e-6
DEFAULT_TOPOLOGY = "report"

RESULT_NAMES = ("result", "model", "part")


def shape_of(target: Any) -> Any:
    """The Shape behind a Workplane, or the Shape itself."""
    return target.val() if hasattr(target, "val") else target


def measure(target: Any) -> dict[str, Any]:
    """The corpus measures for a CadQuery Workplane or Shape."""
    shape = shape_of(target)
    bbox = shape.BoundingBox()
    return {
        "bodies": len(shape.Solids()),
        "volume": shape.Volume(),
        "area": shape.Area(),
        "centroid": list(shape.Center().toTuple()),
        "bbox": [bbox.xmin, bbox.ymin, bbox.zmin, bbox.xmax, bbox.ymax, bbox.zmax],
        "faces": len(shape.Faces()),
        "edges": len(shape.Edges()),
    }


def build_reference(
    target: Any,
    *,
    version: str,
    source_file: str,
    rel: float = DEFAULT_REL,
    abs_: float = DEFAULT_ABS,
    topology: str = DEFAULT_TOPOLOGY,
) -> dict[str, Any]:
    """A reference.json object for one measured CadQuery result."""
    return {
        "source": {"tool": "cadquery", "version": version, "file": source_file},
        "tolerance": {"rel": rel, "abs": abs_},
        "topology": topology,
        **measure(target),
    }


def execute_source(path: pathlib.Path, namespace: dict[str, Any] | None = None) -> Any:
    """Execute a CadQuery script and return the object it names as its result."""
    scope: dict[str, Any] = {"__name__": "__cadquery_reference__", "__file__": str(path)}
    if namespace:
        scope.update(namespace)
    exec(compile(path.read_text(), str(path), "exec"), scope)
    for name in RESULT_NAMES:
        if name in scope:
            return scope[name]
    raise SystemExit(f"{path}: define the finished workplane or shape as `result`")


def export_step(target: Any, path: pathlib.Path) -> None:
    """Write the measured result as STEP, via CadQuery's own exporter."""
    import cadquery as cq

    cq.exporters.export(target, str(path))


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("source", type=pathlib.Path, help="CadQuery script to execute")
    parser.add_argument("--out", type=pathlib.Path, help="reference.json to write (default: beside the source)")
    parser.add_argument("--step", type=pathlib.Path, help="optional STEP export of the result")
    parser.add_argument("--rel", type=float, default=DEFAULT_REL, help="relative tolerance the case claims")
    parser.add_argument("--abs", type=float, default=DEFAULT_ABS, help="absolute tolerance the case claims")
    parser.add_argument(
        "--topology",
        choices=("report", "strict"),
        default=DEFAULT_TOPOLOGY,
        help="report keeps face and edge counts informational",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not args.source.is_file():
        raise SystemExit(f"{args.source}: not a file")

    import cadquery as cq

    result = execute_source(args.source, {"cq": cq, "cadquery": cq, "Workplane": cq.Workplane})
    reference = build_reference(
        result,
        version=importlib.metadata.version("cadquery"),
        source_file=args.source.name,
        rel=args.rel,
        abs_=args.abs,
        topology=args.topology,
    )

    out = args.out or args.source.with_name("reference.json")
    out.write_text(json.dumps(reference, indent=2) + "\n")
    if args.step:
        export_step(result, args.step)
    print(f"{out}: volume={reference['volume']} area={reference['area']} bodies={reference['bodies']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
