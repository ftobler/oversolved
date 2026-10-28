"""Generate the fit-spline golden fixture from OCP.

The sketch solver's interpolating spline must match what CadQuery builds through
`GeomAPI_Interpolate`. OCP is the oracle: this script writes the cases once,
`sketch-solver/src/fit_spline/golden.json` is committed, and both the Rust and
the TypeScript suites read that file. Regenerate with

    .venv/bin/python tests/fit_spline_golden.py

`tests/test_fit_spline_golden.py` re-runs the generator when OCP imports and
diffs the result, so a hand-edited fixture cannot pass.

Only the cases OCP and our algorithm agree on are recorded. The one documented
deviation, N = 2 with a single handle, is left out on purpose: OCP gives that
free end a zero derivative while we use the chord rule (see the plan D4).
"""

from __future__ import annotations

import importlib.metadata
import json
import math
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
GOLDEN = ROOT / "sketch-solver" / "src" / "fit_spline" / "golden.json"

# 9 interior samples per span, at the chord parameter fractions 1/10..9/10.
SAMPLES_PER_SPAN = 9

# Ex010's points with `includeCurrent=True`: the current point (3, 1) first.
EX010 = [
    (3.0, 1.0),
    (2.75, 1.5),
    (2.5, 1.75),
    (2.0, 1.5),
    (1.5, 1.0),
    (1.0, 1.25),
    (0.5, 1.0),
    (0.0, 1.0),
]

POINTS = {
    2: [(0.0, 0.0), (2.0, 1.0)],
    3: [(0.0, 0.0), (1.0, 2.0), (3.0, 1.0)],
    4: [(0.0, 0.0), (1.0, 2.0), (3.0, 1.0), (4.0, 3.0)],
    5: [(0.0, 0.0), (1.0, 2.0), (3.0, 1.0), (4.0, 3.0), (6.0, 2.0)],
}

TANGENTS = {
    2: ((0.0, 1.0), (-1.0, 1.0)),
    3: ((1.0, 0.5), (-0.5, 1.0)),
    4: ((1.0, 0.5), (-0.5, 1.0)),
    5: ((0.5, 1.0), (-1.0, 0.5)),
}


def chord_params(points: list[tuple[float, float]]) -> list[float]:
    """Cumulative chord length, the parameter OCP's interpolate builds."""
    us = [0.0]
    for i in range(1, len(points)):
        us.append(us[-1] + math.dist(points[i - 1], points[i]))
    return us


def handle_point(
    points: list[tuple[float, float]],
    us: list[float],
    tangent: tuple[float, float],
    at_start: bool,
) -> tuple[float, float]:
    """The absolute handle point that stores `tangent` as the end derivative.

    D2: the start handle is the first Bezier piece's second control point, so
    `D = 3 (c1 - P0) / h0`; the end handle is the last piece's third control
    point, so `D = 3 (P_last - c2) / h_last`.
    """
    if at_start:
        h = us[1] - us[0]
        return (points[0][0] + h * tangent[0] / 3.0, points[0][1] + h * tangent[1] / 3.0)
    h = us[-1] - us[-2]
    return (points[-1][0] - h * tangent[0] / 3.0, points[-1][1] - h * tangent[1] / 3.0)


def _interpolate(points: list[tuple[float, float]], load: object) -> object:
    """Run OCP's GeomAPI_Interpolate with the given `Load` call applied."""
    from OCP.GeomAPI import GeomAPI_Interpolate
    from OCP.gp import gp_Pnt
    from OCP.TColgp import TColgp_HArray1OfPnt

    array = TColgp_HArray1OfPnt(1, len(points))
    for i, point in enumerate(points, 1):
        array.SetValue(i, gp_Pnt(point[0], point[1], 0.0))
    interpolate = GeomAPI_Interpolate(array, False, 1e-9)
    if load is not None:
        load(interpolate)
    interpolate.Perform()
    return interpolate.Curve()


def _load_both(t0: tuple[float, float], t1: tuple[float, float], scale: bool):  # type: ignore[no-untyped-def]
    from OCP.gp import gp_Vec

    def load(interpolate) -> None:  # type: ignore[no-untyped-def]
        interpolate.Load(gp_Vec(t0[0], t0[1], 0.0), gp_Vec(t1[0], t1[1], 0.0), scale)

    return load


def _load_one(
    index: int, count: int, tangent: tuple[float, float], scale: bool
):  # type: ignore[no-untyped-def]
    from OCP.gp import gp_Vec
    from OCP.TColgp import TColgp_Array1OfVec
    from OCP.TColStd import TColStd_HArray1OfBoolean

    def load(interpolate) -> None:  # type: ignore[no-untyped-def]
        tangents = TColgp_Array1OfVec(1, count)
        flags = TColStd_HArray1OfBoolean(1, count)
        for i in range(1, count + 1):
            tangents.SetValue(i, gp_Vec(0.0, 0.0, 0.0))
            flags.SetValue(i, False)
        tangents.SetValue(index, gp_Vec(tangent[0], tangent[1], 0.0))
        flags.SetValue(index, True)
        interpolate.Load(tangents, flags, scale)

    return load


def _chain_poles(curve: object, us: list[float]) -> list[list[float]]:
    """OCP's curve as the C0 cubic Bezier chain our solver builds.

    A degree 1 or 2 curve is raised first; then every interior chord parameter
    is inserted to multiplicity 3, which leaves exactly the per-span Bezier
    control points.
    """
    chain = curve.Copy()  # type: ignore[attr-defined]
    if chain.Degree() < 3:
        chain.IncreaseDegree(3)
    for i in range(1, len(us) - 1):
        multiplicity = 0
        for j in range(1, chain.NbKnots() + 1):
            if abs(chain.Knot(j) - us[i]) < 1e-9:
                multiplicity = chain.Multiplicity(j)
        if multiplicity < 3:
            chain.InsertKnot(us[i], 3, 1e-9)
    return [[chain.Pole(i).X(), chain.Pole(i).Y()] for i in range(1, chain.NbPoles() + 1)]


def _samples(curve: object, us: list[float]) -> list[list[list[float]]]:
    """9 interior points per span, at the chord parameter fractions."""
    spans: list[list[list[float]]] = []
    for i in range(len(us) - 1):
        span: list[list[float]] = []
        for k in range(1, SAMPLES_PER_SPAN + 1):
            u = us[i] + (us[i + 1] - us[i]) * k / (SAMPLES_PER_SPAN + 1)
            point = curve.Value(u)  # type: ignore[attr-defined]
            span.append([point.X(), point.Y()])
        spans.append(span)
    return spans


def _end_derivative(curve: object, u: float) -> list[float]:
    derivative = curve.DN(u, 1)  # type: ignore[attr-defined]
    return [derivative.X(), derivative.Y()]


def build_cases() -> dict[str, object]:
    """The committed fixture, in a stable order."""
    cases: list[dict[str, object]] = []

    def add(
        name: str,
        points: list[tuple[float, float]],
        load: object,
        handle_start: tuple[float, float] | None,
        handle_end: tuple[float, float] | None,
        scale: bool,
    ) -> None:
        us = chord_params(points)
        curve = _interpolate(points, load)
        cases.append(
            {
                "name": name,
                "points": [list(p) for p in points],
                "handle_start": list(handle_start) if handle_start is not None else None,
                "handle_end": list(handle_end) if handle_end is not None else None,
                "scale": scale,
                "degree": curve.Degree(),
                "poles": [
                    [curve.Pole(i).X(), curve.Pole(i).Y()]
                    for i in range(1, curve.NbPoles() + 1)
                ],
                "knots": [curve.Knot(i) for i in range(1, curve.NbKnots() + 1)],
                "mults": [curve.Multiplicity(i) for i in range(1, curve.NbKnots() + 1)],
                "chain": _chain_poles(curve, us),
                "tangent_start": _end_derivative(curve, us[0]),
                "tangent_end": _end_derivative(curve, us[-1]),
                "samples": _samples(curve, us),
            }
        )

    add("ex010", EX010, None, None, None, False)
    for n in (2, 3, 4, 5):
        add(f"n{n}", POINTS[n], None, None, None, False)

    # Both handles, scale=False: the stored handles ARE the end derivatives.
    for n in (2, 3, 4, 5):
        points = POINTS[n]
        us = chord_params(points)
        t0, t1 = TANGENTS[n]
        add(
            f"n{n}_both_noscale",
            points,
            _load_both(t0, t1, False),
            handle_point(points, us, t0, True),
            handle_point(points, us, t1, False),
            False,
        )

    # One handle, scale=False: the free end takes the Lagrange rule.
    for n in (3, 4, 5):
        points = POINTS[n]
        us = chord_params(points)
        t0, t1 = TANGENTS[n]
        add(
            f"n{n}_start_noscale",
            points,
            _load_one(1, n, t0, False),
            handle_point(points, us, t0, True),
            None,
            False,
        )
        add(
            f"n{n}_end_noscale",
            points,
            _load_one(n, n, t1, False),
            None,
            handle_point(points, us, t1, False),
            False,
        )

    # Both handles, scale=True: OCP's ScaleTangents rescales each given vector.
    # The stored handle is the SCALED one, which is what the authoring sugar
    # writes, so the fixture pins the port of that rule too.
    for n in (2, 3, 4, 5):
        points = POINTS[n]
        us = chord_params(points)
        t0, t1 = TANGENTS[n]
        curve = _interpolate(points, _load_both(t0, t1, True))
        scaled0 = _end_derivative(curve, us[0])
        scaled1 = _end_derivative(curve, us[-1])
        add(
            f"n{n}_both_scale",
            points,
            _load_both(t0, t1, True),
            handle_point(points, us, (scaled0[0], scaled0[1]), True),
            handle_point(points, us, (scaled1[0], scaled1[1]), False),
            True,
        )

    return {
        "source": {
            "tool": "OCP",
            "version": importlib.metadata.version("cadquery"),
            "generator": "tests/fit_spline_golden.py",
        },
        "samples_per_span": SAMPLES_PER_SPAN,
        "cases": cases,
    }


def main() -> None:
    fixture = build_cases()
    GOLDEN.parent.mkdir(parents=True, exist_ok=True)
    GOLDEN.write_text(json.dumps(fixture, indent=2) + "\n")
    print(f"wrote {GOLDEN} ({len(fixture['cases'])} cases)")  # type: ignore[index]


if __name__ == "__main__":
    main()
