"""Heuristic scoring layer for recursive ancestral query resolution.

All scoring knobs live in HeuristicConfig -- data, not magic numbers.
The walker (in query.py) delegates partial-branch matching here so the
resolver is pure structure and heuristics can be tuned without touching
the descent logic.

Resolution is three-valued on purpose:
  Resolved   -- exactly one winner
  Ambiguous  -- multiple plausible candidates → surface red
  Unresolved -- no match → surface red
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Any


class Outcome(Enum):
    RESOLVED = auto()
    AMBIGUOUS = auto()
    UNRESOLVED = auto()


@dataclass(frozen=True)
class HeuristicConfig:
    """All heuristic scoring knobs in one place.

    Overridable per-solve (experiment harness) and per-test (so tests can
    pin thresholds without touching any producer or walker code).
    """

    # minimum fraction of old constituent-entity IDs that must appear in
    # a new candidate (0.0 .. 1.0). Used by match_area_reid and the
    # generalization in resolve_query.
    overlap_threshold: float = 0.5

    # per-ancestor-kind weights for scoring partial branches.
    # Default: unassigned kinds get weight 1.0.
    kind_weights: dict[str, float] = field(default_factory=dict)

    # tolerance for geometry-leaf comparison. Two geometry measurements
    # (area, length, etc.) whose relative difference is ≤ this are
    # considered "same geometry."
    geometry_leaf_tolerance: float = 0.01

    # ambiguity margin: the top candidate's score must beat the runner-up
    # by at least this amount to count as Resolved. Otherwise Ambiguous.
    ambiguity_margin: float = 0.0

    def weight_for(self, kind: str) -> float:
        return self.kind_weights.get(kind, 1.0)


# the tuning knob data, not a magic constant
DEFAULT_HEURISTIC_CONFIG = HeuristicConfig()


def score_overlap(old_ids: frozenset[str], new_ids: frozenset[str]) -> float:
    """Fraction of old_ids present in new_ids (0.0 .. 1.0)."""
    if not old_ids:
        return 0.0
    return len(old_ids & new_ids) / len(old_ids)


def score_geometry_leaf(
    old_geom: dict | None,
    new_geom: dict | None,
    cfg: HeuristicConfig,
) -> float:
    """Score how similar two geometry hints are.

    Returns 1.0 (identical within tolerance) or 0.0 (different).
    Geometry hints are compared field-by-field for numeric tolerance.
    """
    if old_geom is None or new_geom is None:
        return 1.0  # no hint → no penalty
    keys = set(old_geom.keys()) & set(new_geom.keys())
    if not keys:
        return 0.0
    matches = 0
    for k in keys:
        ov = old_geom.get(k)
        nv = new_geom.get(k)
        if ov is None or nv is None:
            if ov == nv:
                matches += 1
            continue
        if isinstance(ov, (int, float)) and isinstance(nv, (int, float)):
            if abs(ov) < 1e-12 and abs(nv) < 1e-12:
                matches += 1
            elif abs(ov - nv) / max(abs(ov), 1e-12) <= cfg.geometry_leaf_tolerance:
                matches += 1
        else:
            if ov == nv:
                matches += 1
    return matches / len(keys)


def pick_best(
    scores: list[tuple[Any, float]],
    cfg: HeuristicConfig,
) -> tuple[Outcome, Any | None]:
    """Given scored candidates, return the outcome and winner (if any).

    The winner must beat the runner-up by strictly more than
    cfg.ambiguity_margin to count as Resolved. Equal scores with
    margin 0.0 are Ambiguous.
    """
    if not scores:
        return Outcome.UNRESOLVED, None
    sorted_scores = sorted(scores, key=lambda x: x[1], reverse=True)
    if len(sorted_scores) == 1:
        return Outcome.RESOLVED, sorted_scores[0][0]
    top_score = sorted_scores[0][1]
    runner_up = sorted_scores[1][1]
    if top_score - runner_up > cfg.ambiguity_margin:
        return Outcome.RESOLVED, sorted_scores[0][0]
    return Outcome.AMBIGUOUS, None
