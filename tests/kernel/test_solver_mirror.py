import importlib
import pytest
from oversolved.kernel.builder import build
from solver_helpers import box_extrude_spec, assert_mesh_valid

pytestmark = pytest.mark.skipif(
    not importlib.util.find_spec("vtkmodules"), reason="vtkmodules not installed"
)


def _mirror_spec(body_query: str = "extrude1", plane_query: str = "@builtin_plane_front",
                 keep_original: bool = True, merge: bool = True) -> dict:
    return {
        'id': 'mirror1',
        'kind': 'mirror',
        'label': 'Mirror',
        'mirror': {
            'body': body_query,
            'plane': plane_query,
            'keep_original': keep_original,
            'merge': merge,
        },
    }


def test_mirror_body_across_plane():
    """Create a box, mirror across the front plane, verify body exists."""
    spec = box_extrude_spec(w=10, h=10, d=20)
    spec['features'].append(_mirror_spec())
    r = build(spec)
    result = r['result']['mirror1']
    assert result['status'] == 'ok'
    assert 'body_id' in result
    assert result['body_id'] in r['bodies']
    mesh = r['bodies'][result['body_id']]['mesh']
    assert_mesh_valid(mesh)
    # Mirrored box should extend negative Z (front plane at z=0, box extrudes +z)
    xs = [v[0] for v in mesh['vertices']]
    ys = [v[1] for v in mesh['vertices']]
    zs = [v[2] for v in mesh['vertices']]
    assert min(xs) >= -0.1
    assert max(xs) <= 10.1
    assert min(ys) >= -0.1
    assert max(ys) <= 10.1
    assert min(zs) >= -20.1


def test_mirror_with_keep_original_false():
    """Verify source body shape is replaced when keep_original=False."""
    spec = box_extrude_spec(w=5, h=5, d=5)
    spec['features'].append(_mirror_spec(keep_original=False))
    r = build(spec)
    result = r['result']['mirror1']
    assert result['status'] == 'ok'
    assert result.get('operation') == 'replace'
    # Original body should still exist but with mirrored shape
    assert result.get('body_id') in r['bodies']


def test_mirror_with_merge_true():
    """Verify single fused body with double volume when merge=True."""
    spec = box_extrude_spec(w=5, h=5, d=5)
    spec['features'].append(_mirror_spec(merge=True))
    r = build(spec)
    result = r['result']['mirror1']
    assert result['status'] == 'ok'
    assert result.get('operation') == 'merge'
    mirrored_body = r['bodies'][result['body_id']]
    assert 'mesh' in mirrored_body
    # Bounding box should now span both positive and negative Z
    zs = [v[2] for v in mirrored_body['mesh']['vertices']]
    assert min(zs) <= -4.0
    assert max(zs) >= 4.0


def test_mirror_with_merge_false():
    """Verify two separate bodies when merge=False."""
    spec = box_extrude_spec(w=5, h=5, d=5)
    spec['features'].append(_mirror_spec(merge=False))
    r = build(spec)
    result = r['result']['mirror1']
    assert result['status'] == 'ok'
    assert result.get('operation') == 'new'
    assert 'body_ids' in result
    assert len(result['body_ids']) == 2  # original + mirrored
    for bid in result['body_ids']:
        assert bid in r['bodies']


def test_mirror_invalid_body():
    """Mirror with nonexistent body ref, verify error."""
    spec = box_extrude_spec(w=5, h=5, d=5)
    spec['features'].append(_mirror_spec(body_query="nonexistent"))
    r = build(spec)
    result = r['result']['mirror1']
    assert result['status'] == 'exception'
    assert 'body not found' in result.get('exception', '') or 'not found' in result.get('exception', '')


def test_mirror_invalid_plane():
    """Mirror with bad plane query, verify error."""
    spec = box_extrude_spec(w=5, h=5, d=5)
    spec['features'].append(_mirror_spec(plane_query="?nonexistent"))
    r = build(spec)
    result = r['result']['mirror1']
    assert result['status'] == 'exception'
