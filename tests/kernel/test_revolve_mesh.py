import importlib
import pytest

pytestmark = [
    pytest.mark.skipif(
        not importlib.util.find_spec("cadquery"), reason="cadquery not installed"
    ),
    pytest.mark.skipif(
        not importlib.util.find_spec("vtkmodules"), reason="vtkmodules not installed"
    ),
]


def _rect_sketch_at_offset(w=2.0, h=1.0, offset_x=1.0, sketch_id='sk1'):
    """Return a rectangle sketch spec positioned away from the origin."""
    from solver_helpers import rect_sketch_spec
    spec = rect_sketch_spec(w=w, h=h, sketch_id=sketch_id)
    # Shift all vertices by offset_x so the rectangle is at [offset_x, offset_x + w]
    for key in spec['initial']:
        spec['initial'][key] = [
            spec['initial'][key][0] + offset_x,
            spec['initial'][key][1],
            spec['initial'][key][2] + offset_x,
            spec['initial'][key][3],
        ]
    return spec


def _revolve_spec(sketch_id: str, revolve_id: str, angle: float = 360.0, operation: str = 'add'):
    return {
        'id': revolve_id,
        'kind': 'revolve',
        'label': 'Revolve',
        'sketch': '$' + sketch_id,
        'angle': angle,
        'axis_origin': [0, 0, 0],
        'axis_direction': [0, 1, 0],
        'operation': operation,
    }


def test_revolve_status_ok():
    from oversolved.kernel.builder import build
    from solver_helpers import assert_mesh_valid

    spec = {
        'features': [
            _rect_sketch_at_offset(w=2.0, h=1.0, offset_x=1.0, sketch_id='sk1'),
            _revolve_spec('sk1', 'rev1', angle=360.0),
        ]
    }
    r = build(spec)
    assert r['result']['rev1']['status'] == 'ok', r['result']['rev1']
    assert 'body_rev1' in r['bodies']
    mesh = r['bodies']['body_rev1']['mesh']
    assert_mesh_valid(mesh)


def test_revolve_has_body_id():
    from oversolved.kernel.builder import build

    spec = {
        'features': [
            _rect_sketch_at_offset(w=2.0, h=1.0, offset_x=1.0, sketch_id='sk1'),
            _revolve_spec('sk1', 'rev1', angle=360.0),
        ]
    }
    r = build(spec)
    assert r['result']['rev1']['body_id'] == 'body_rev1'


def test_revolve_mesh_valid():
    from oversolved.kernel.builder import build
    from solver_helpers import assert_mesh_valid

    spec = {
        'features': [
            _rect_sketch_at_offset(w=2.0, h=1.0, offset_x=1.0, sketch_id='sk1'),
            _revolve_spec('sk1', 'rev1', angle=360.0),
        ]
    }
    r = build(spec)
    mesh = r['bodies']['body_rev1']['mesh']
    assert_mesh_valid(mesh)


def test_revolve_bbox_cylinder():
    """Rectangle [1,0] to [3,1] revolved 360 around y-axis should span x/z roughly [-3,3] and y [0,1]."""
    from oversolved.kernel.builder import build
    from solver_helpers import assert_mesh_bbox

    spec = {
        'features': [
            _rect_sketch_at_offset(w=2.0, h=1.0, offset_x=1.0, sketch_id='sk1'),
            _revolve_spec('sk1', 'rev1', angle=360.0),
        ]
    }
    r = build(spec)
    mesh = r['bodies']['body_rev1']['mesh']
    assert_mesh_bbox(mesh, x_range=(-3, 3), y_range=(0, 1), z_range=(-3, 3))


def test_revolve_cut_removes_volume():
    """Cut revolve subtracts from a base body."""
    from oversolved.kernel.builder import build
    from solver_helpers import assert_mesh_valid

    # Base: rectangle [1,0]-[3,1] revolved 360 -> tube
    base = _revolve_spec('sk1', 'rev1', angle=360.0)
    # Cut: smaller rectangle [1.5,0]-[2.5,1] revolved 360 -> smaller tube
    cut = _revolve_spec('sk2', 'rev2', angle=360.0, operation='cut')
    spec = {
        'features': [
            _rect_sketch_at_offset(w=2.0, h=1.0, offset_x=1.0, sketch_id='sk1'),
            base,
            _rect_sketch_at_offset(w=1.0, h=1.0, offset_x=1.5, sketch_id='sk2'),
            cut,
        ]
    }
    r = build(spec)
    assert r['result']['rev1']['status'] == 'ok'
    assert r['result']['rev2']['status'] == 'ok'
    assert 'body_rev2' not in r['bodies']
    assert 'body_rev1' in r['bodies']
    mesh = r['bodies']['body_rev1']['mesh']
    assert_mesh_valid(mesh)


def test_revolve_from_sketch_surface_query():
    """Revolve uses a ?-ancestry query for a sketch surface flatface as the profile."""
    from oversolved.kernel.builder import build
    from oversolved.kernel.query import make_ancestry_query
    from solver_helpers import assert_mesh_valid

    sketch_id = 'sk1'
    circle_id = 'c1'
    surface_query = make_ancestry_query(
        [f'@{sketch_id}{circle_id}', 'surface:0', f'@{sketch_id}'],
        'flatface',
    )

    spec = {
        'features': [
            {
                'id': sketch_id,
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [{'id': circle_id, 'kind': 'circle'}],
                'initial': {circle_id: [2, 0, 0.5]},
                'constraints': [
                    {'id': 'co1', 'kind': 'coincident',
                     'a': f'${sketch_id}{circle_id}center', 'b': '@builtin_origin'},
                    {'id': 'd1', 'kind': 'diameter',
                     'target': f'${sketch_id}{circle_id}', 'value': 1},
                ],
            },
            {
                'id': 'rev1',
                'kind': 'revolve',
                'sketch': surface_query,
                'angle': 360.0,
                'axis_origin': [0, 0, 0],
                'axis_direction': [0, 1, 0],
            },
        ]
    }
    r = build(spec)
    assert r['result']['sk1']['status'] != 'exception', r['result']['sk1']
    assert r['result']['rev1']['status'] == 'ok', r['result']['rev1']
    assert 'body_rev1' in r['bodies']
    assert_mesh_valid(r['bodies']['body_rev1']['mesh'])


def test_revolve_sketch_list_two_profiles():
    """sketch field as a list of two sketch refs revolves both profiles into one body."""
    from oversolved.kernel.builder import build
    from solver_helpers import assert_mesh_valid

    spec = {
        'features': [
            _rect_sketch_at_offset(w=1.0, h=1.0, offset_x=1.0, sketch_id='sk1'),
            _rect_sketch_at_offset(w=1.0, h=1.0, offset_x=3.0, sketch_id='sk2'),
            {
                'id': 'rev1',
                'kind': 'revolve',
                'sketch': ['$sk1', '$sk2'],
                'angle': 360.0,
                'axis_origin': [0, 0, 0],
                'axis_direction': [0, 1, 0],
            },
        ]
    }
    r = build(spec)
    assert r['result']['rev1']['status'] == 'ok', r['result']['rev1']
    assert 'body_rev1' in r['bodies']
    mesh = r['bodies']['body_rev1']['mesh']
    assert len(mesh['vertices']) > 0
    assert len(mesh['faces']) > 0
    assert_mesh_valid(mesh)


def test_revolve_nested_ui_format():
    """UI serializes revolve as {kind, id, revolve: {sketch, angle, ...}}."""
    from oversolved.kernel.builder import build
    from solver_helpers import assert_mesh_valid

    spec = {
        'features': [
            _rect_sketch_at_offset(w=2.0, h=1.0, offset_x=1.0, sketch_id='sk1'),
            {
                'id': 'rev1',
                'kind': 'revolve',
                'label': 'Revolve 1',
                'revolve': {
                    'sketch': '$sk1',
                    'angle': 360.0,
                    'axis_origin': [0, 0, 0],
                    'axis_direction': [0, 1, 0],
                },
            },
        ]
    }
    r = build(spec)
    assert r['result']['rev1']['status'] == 'ok', r['result']['rev1']
    assert 'body_rev1' in r['bodies']
    assert_mesh_valid(r['bodies']['body_rev1']['mesh'])


def test_revolve_new_creates_new_body():
    """revolve operation: new creates a new body even when other bodies exist."""
    from oversolved.kernel.builder import build
    from solver_helpers import assert_mesh_valid

    spec = {
        'features': [
            _rect_sketch_at_offset(w=2.0, h=1.0, offset_x=1.0, sketch_id='sk1'),
            _revolve_spec('sk1', 'rev1', angle=360.0),
            _rect_sketch_at_offset(w=1.0, h=1.0, offset_x=4.0, sketch_id='sk2'),
            {
                'id': 'rev2',
                'kind': 'revolve',
                'sketch': '$sk2',
                'angle': 360.0,
                'axis_origin': [0, 0, 0],
                'axis_direction': [0, 0, 1],
                'operation': 'new',
            },
        ]
    }
    r = build(spec)
    assert 'body_rev1' in r['bodies']
    assert 'body_rev2' in r['bodies']
    assert_mesh_valid(r['bodies']['body_rev1']['mesh'])
    assert_mesh_valid(r['bodies']['body_rev2']['mesh'])
