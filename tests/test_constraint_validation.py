"""Tests for constraint validation and auto-deletion fixes.

These tests cover fixes for the following bug reports:
- constraint_auto_delete_not_working_20260403_233520
- failed_ghost_constraint_20260403_233849
- constraint_between_two_sketches_20260403_233102
"""
from oversolved.solver import _solve_sketch
from oversolved.query import Repository
from oversolved.solver import _register_solved_geometry


class TestConstraintAutoDeletion:
    """Test that invalid constraints are automatically deleted."""

    def test_corrupted_builtin_reference_auto_deletion(self):
        """Constraint with corrupted builtin reference (@builtin_oaaaa...) should be auto-deleted."""
        result = _solve_sketch({
            'id': 'sketch1',
            'kind': 'sketch',
            'plane': '@builtin_plane_front',
            'entities': [{'id': 'pt', 'kind': 'point'}],
            'initial': {'pt': [1.0, 2.0]},
            'constraints': [
                {
                    'id': 'c_corrupted',
                    'kind': 'fixed',
                    'target': '@builtin_oaaaaaaaaaaaaaaaaaarigin',  # corrupted reference
                    'x': 1.0,
                    'y': 2.0
                },
                {
                    'id': 'c_valid',
                    'kind': 'fixed',
                    'target': '$pt',
                    'x': 1.0,
                    'y': 2.0
                }
            ]
        })
        assert 'c_corrupted' not in result['constraints'], "Corrupted constraint should be deleted"
        assert 'c_valid' in result['constraints'], "Valid constraint should be kept"
        assert result['status'] == 'fully_constrained'

    def test_invalid_cross_sketch_reference_auto_deletion(self):
        """Constraint with invalid cross-sketch reference should be auto-deleted."""
        result = _solve_sketch({
            'id': 'sketch2',
            'kind': 'sketch',
            'plane': '@builtin_plane_top',
            'entities': [],
            'initial': {},
            'constraints': [
                {
                    'id': 'c_invalid',
                    'kind': 'fixed',
                    'target': '@sketch1_nonexistent',  # invalid cross-sketch reference
                    'x': 1.0,
                    'y': 2.0
                },
                {
                    'id': 'c_valid_fixed',
                    'kind': 'fixed',
                    'target': '@builtin_origin',
                    'x': 0.0,
                    'y': 0.0
                }
            ]
        })
        assert 'c_invalid' not in result['constraints'], "Invalid constraint should be deleted"
        assert 'c_valid_fixed' in result['constraints'], "Valid constraint should be kept"

    def test_external_only_vertical_constraint_auto_deletion(self):
        """Constraint with only external target should be auto-deleted for constraint types needing local entity."""
        # First, solve sketch1
        sketch1_result = _solve_sketch({
            'id': 'sketch1',
            'kind': 'sketch',
            'plane': '@builtin_plane_top',
            'entities': [{'id': 'pt1', 'kind': 'point'}],
            'initial': {'pt1': [-1, 0]},
            'constraints': [
                {'id': 'c_fix', 'kind': 'fixed', 'target': '$pt1', 'x': -1, 'y': 0}
            ]
        })

        # Register sketch1's geometry in global repo
        global_repo = Repository()
        _register_solved_geometry(
            global_repo,
            'sketch1',
            {'entities': [{'id': 'pt1', 'kind': 'point'}]},
            sketch1_result['geometry']
        )

        # Solve sketch2 with invalid external-only vertical constraint
        sketch2_result = _solve_sketch({
            'id': 'sketch2',
            'kind': 'sketch',
            'plane': '@builtin_plane_top',
            'entities': [{'id': 'pt2', 'kind': 'point'}],
            'initial': {'pt2': [-1.23, -0.75]},
            'constraints': [
                {
                    'id': 'c_vertical_external',
                    'kind': 'vertical',
                    'target': '@sketch1pt1xy'  # only external target — invalid
                }
            ]
        }, global_repo=global_repo)

        # The constraint should be auto-deleted instead of causing an exception
        assert 'c_vertical_external' not in sketch2_result['constraints']
        assert sketch2_result['status'] != 'exception'

    def test_valid_cross_sketch_point_distance(self):
        """Valid cross-sketch constraint (point_distance) should work with mixed local/external refs."""
        # First, solve sketch1
        sketch1_result = _solve_sketch({
            'id': 'sketch1',
            'kind': 'sketch',
            'plane': '@builtin_plane_top',
            'entities': [{'id': 'pt1', 'kind': 'point'}],
            'initial': {'pt1': [-1, 0]},
            'constraints': [
                {'id': 'c_fix', 'kind': 'fixed', 'target': '$pt1', 'x': -1, 'y': 0}
            ]
        })

        # Register sketch1's geometry
        global_repo = Repository()
        _register_solved_geometry(
            global_repo,
            'sketch1',
            {'entities': [{'id': 'pt1', 'kind': 'point'}]},
            sketch1_result['geometry']
        )

        # Solve sketch2 with valid cross-sketch point_distance
        sketch2_result = _solve_sketch({
            'id': 'sketch2',
            'kind': 'sketch',
            'plane': '@builtin_plane_top',
            'entities': [{'id': 'pt2', 'kind': 'point'}],
            'initial': {'pt2': [0, 0]},
            'constraints': [
                {
                    'id': 'c_distance',
                    'kind': 'point_distance',
                    'a': '$pt2',
                    'b': '@sketch1pt1xy',  # external reference
                    'value': 1
                }
            ]
        }, global_repo=global_repo)

        # The constraint should be kept and solve successfully
        assert 'c_distance' in sketch2_result['constraints']
        assert sketch2_result['status'] == 'fully_constrained'
