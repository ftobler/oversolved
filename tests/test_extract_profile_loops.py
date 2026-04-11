from pytest import approx
from oversolved.solver import _extract_profile_loops

DUMMY_PLANE = {
    "origin": [0, 0, 0],
    "x_axis": [1, 0, 0],
    "y_axis": [0, 1, 0],
    "normal": [0, 0, 1],
}


def surface_from_edges(edges):
    """Build a surface dict from a list of (start, end) tuples."""
    return {"boundary": [{"start": list(s), "end": list(e)} for s, e in edges]}


def test_ordered_square_produces_one_loop():
    edges = [([0, 0], [1, 0]), ([1, 0], [1, 1]), ([1, 1], [0, 1]), ([0, 1], [0, 0])]
    loops = _extract_profile_loops([surface_from_edges(edges)], DUMMY_PLANE)
    assert len(loops) == 1
    assert len(loops[0]) == 4
    pts = set(map(tuple, map(tuple, loops[0])))
    assert (0.0, 0.0) in pts
    assert (1.0, 0.0) in pts
    assert (1.0, 1.0) in pts
    assert (0.0, 1.0) in pts


def test_unordered_square_still_produces_loop():
    edges = [([1, 1], [0, 1]), ([0, 0], [1, 0]), ([0, 1], [0, 0]), ([1, 0], [1, 1])]
    loops = _extract_profile_loops([surface_from_edges(edges)], DUMMY_PLANE)
    assert len(loops) == 1
    assert len(loops[0]) == 4


def test_triangle_produces_three_point_loop():
    edges = [([0, 0], [2, 0]), ([2, 0], [1, 2]), ([1, 2], [0, 0])]
    loops = _extract_profile_loops([surface_from_edges(edges)], DUMMY_PLANE)
    assert len(loops) == 1
    assert len(loops[0]) == 3


def test_pentagon_produces_five_point_loop():
    import math

    pts = [
        [math.cos(2 * math.pi * i / 5), math.sin(2 * math.pi * i / 5)] for i in range(5)
    ]
    edges = [(pts[i], pts[(i + 1) % 5]) for i in range(5)]
    loops = _extract_profile_loops([surface_from_edges(edges)], DUMMY_PLANE)
    assert len(loops) == 1
    assert len(loops[0]) == 5


def test_broken_loop_falls_back_not_crash():
    edges = [([0, 0], [1, 0]), ([1, 0], [1, 1]), ([1, 1], [0, 1])]
    loops = _extract_profile_loops([surface_from_edges(edges)], DUMMY_PLANE)
    assert isinstance(loops, list)


def test_empty_surface_returns_empty():
    loops = _extract_profile_loops([{"boundary": []}], DUMMY_PLANE)
    assert loops == [] or loops == [[]]


def test_no_surfaces_returns_empty():
    loops = _extract_profile_loops([], DUMMY_PLANE)
    assert loops == []


def test_two_surfaces_outer_and_hole():
    outer = [([0, 0], [4, 0]), ([4, 0], [4, 4]), ([4, 4], [0, 4]), ([0, 4], [0, 0])]
    hole = [([1, 1], [3, 1]), ([3, 1], [3, 3]), ([3, 3], [1, 3]), ([1, 3], [1, 1])]
    loops = _extract_profile_loops(
        [surface_from_edges(outer), surface_from_edges(hole)], DUMMY_PLANE
    )
    assert len(loops) == 2
    areas = []
    for loop in loops:
        n = len(loop)
        area = (
            abs(
                sum(
                    loop[i][0] * loop[(i + 1) % n][1]
                    - loop[(i + 1) % n][0] * loop[i][1]
                    for i in range(n)
                )
            )
            / 2
        )
        areas.append(area)
    assert max(areas) == approx(16.0, abs=0.1)
    assert min(areas) == approx(4.0, abs=0.1)


def test_near_touching_within_tolerance_chains():
    eps = 1e-7
    edges = [
        ([0, 0], [1, 0]),
        ([1 + eps, 0], [1, 1]),
        ([1, 1], [0, 1]),
        ([0, 1], [0, 0]),
    ]
    loops = _extract_profile_loops([surface_from_edges(edges)], DUMMY_PLANE)
    assert len(loops) == 1
    assert len(loops[0]) == 4


def test_gap_outside_tolerance_falls_back():
    edges = [([0, 0], [1, 0]), ([1.1, 0], [1, 1]), ([1, 1], [0, 1]), ([0, 1], [0, 0])]
    loops = _extract_profile_loops([surface_from_edges(edges)], DUMMY_PLANE)
    assert isinstance(loops, list)


def test_loop_from_solved_rect_sketch():
    from oversolved.solver import solve_features
    from solver_helpers import rect_sketch_spec

    spec = {"features": [rect_sketch_spec(w=6.0, h=4.0)]}
    result = solve_features(spec)
    topo = result["features"][0].get("topology", {})
    pt = result["features"][0].get("plane_transform", {})
    surfaces = topo.get("surfaces", [])
    assert len(surfaces) >= 1, "rect sketch should have at least 1 surface"
    loops = _extract_profile_loops(surfaces, pt)
    assert len(loops) >= 1
    loop = loops[0]
    xs = [p[0] for p in loop]
    ys = [p[1] for p in loop]
    assert max(xs) == approx(6.0, abs=0.1)
    assert max(ys) == approx(4.0, abs=0.1)
    assert min(xs) == approx(0.0, abs=0.1)
    assert min(ys) == approx(0.0, abs=0.1)
