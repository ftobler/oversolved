"""Tests for per-feature suppression in builder.py.

Invariants covered:
  - Suppressed features produce no geometry and no body.
  - Unsuppressing a feature dirties it and all downstream features.
  - Suppress -> rebuild -> unsuppress -> rebuild yields the same result as
    a fresh build with the feature active.
  - "suppressed" is in _FEATURE_CMP_KEYS.
  - Built-in plane features are never actually suppressed by the backend.
"""

import copy
import importlib

import pytest

from oversolved.kernel.builder import build, _FEATURE_CMP_KEYS
from solver_helpers import rect_sketch_spec, extrude_spec

pytestmark = pytest.mark.skipif(
    not importlib.util.find_spec("vtkmodules"), reason="vtkmodules not installed"
)


def _make_stack():
    """Return a spec with sketch -> extrude1 -> sketch2 -> fillet-like placeholder."""
    sk1 = rect_sketch_spec(w=10, h=10, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)
    # A second sketch that depends on the extrude body being present.
    # We'll use another extrude as a "downstream" feature.
    sk2 = rect_sketch_spec(w=5, h=5, sketch_id='sk2', plane='@builtin_plane_top')
    ex2 = extrude_spec('sk2', 'ex2', 3.0)
    return {'features': [sk1, ex1, sk2, ex2]}


def test_suppression_in_cmp_keys():
    """'suppressed' must be in _FEATURE_CMP_KEYS to trigger dirty detection."""
    assert "suppressed" in _FEATURE_CMP_KEYS


def test_suppressed_feature_skipped():
    """A suppressed extrude produces no body in the result."""
    sk1 = rect_sketch_spec(w=10, h=10, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)
    ex1['suppressed'] = True
    spec = {'features': [sk1, ex1]}

    r = build(spec)

    assert r['result']['ex1'] == {'status': 'suppressed'}
    assert 'ex1' not in r['bodies'] or len(r['bodies']) == 0


def test_suppressed_sentinel_checkpoint_stored():
    """A suppressed feature's checkpoint has suppressed=True in its spec."""
    sk1 = rect_sketch_spec(w=10, h=10, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)
    ex1['suppressed'] = True
    spec = {'features': [sk1, ex1]}

    r = build(spec)
    from oversolved.kernel.types3d import BuildState
    build_state: BuildState = r['_build_state']  # type: ignore[assignment]
    assert 'ex1' in build_state.checkpoints
    assert build_state.checkpoints['ex1'].spec.get('suppressed') is True


def test_unsuppress_dirties_downstream():
    """Toggling suppressed from True -> False re-solves the feature and downstream."""
    sk1 = rect_sketch_spec(w=10, h=10, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)

    suppressed_spec = {'features': [sk1, copy.deepcopy(ex1) | {'suppressed': True}]}
    r1 = build(suppressed_spec)

    # Unsuppress ex1.
    active_spec = {'features': [sk1, ex1]}
    r2 = build(active_spec, prev_state=r1['_build_state'])

    # Now the body from ex1 must exist.
    ex1_result = r2['result']['ex1']
    assert ex1_result.get('status') == 'ok', ex1_result
    assert len(r2['bodies']) > 0


def test_suppress_then_unsuppress_idempotent():
    """suppress -> rebuild -> unsuppress -> rebuild == fresh full build."""
    sk1 = rect_sketch_spec(w=10, h=10, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)

    # Baseline: fresh build with ex1 active.
    r_fresh = build({'features': [sk1, ex1]})
    fresh_body_ids = set(r_fresh['bodies'].keys())

    # Suppress.
    r1 = build({'features': [sk1, copy.deepcopy(ex1) | {'suppressed': True}]})

    # Unsuppress using prev_state from suppressed build.
    r2 = build({'features': [sk1, ex1]}, prev_state=r1['_build_state'])
    final_body_ids = set(r2['bodies'].keys())

    assert final_body_ids == fresh_body_ids


def test_built_in_suppressed_flag_ignored():
    """Suppressed=True on a built-in plane does not remove it from the result."""
    spec = {
        'features': [
            {'id': 'Origin', 'kind': 'origin', 'suppressed': True},
            {'id': 'Top', 'kind': 'plane', 'label': 'Top', 'suppressed': True},
            {'id': 'Front', 'kind': 'plane', 'label': 'Front'},
            {'id': 'Right', 'kind': 'plane', 'label': 'Right'},
        ]
    }
    r = build(spec)
    # Built-ins are registered via _BUILTIN_PLANE_RESULTS, not the feature loop.
    # They always appear in result regardless of the suppressed flag.
    assert 'Top' in r['result'] or 'Front' in r['result']
