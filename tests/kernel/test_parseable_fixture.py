"""Tests for the parseable_fixture test helper.

Invariants:
  - make_doc / make_sketch produce feature/entity IDs equal to the supplied
    parseable strings.
  - Serialising a doc built by the helper yields standard YAML with no extra
    metadata layer -- only the expected keys appear.
"""

import yaml

from parseable_fixture import make_doc, make_sketch


def test_parseable_fixture_builds_doc():
    """Feature and entity IDs in the produced doc equal the parseable strings."""
    doc = make_doc(
        make_sketch(
            "sketch1",
            entities=[
                {"id": "line1", "kind": "line"},
                {"id": "arc1", "kind": "arc"},
            ],
            constraints=[
                {"id": "c1", "kind": "horizontal", "target": {"entity": "line1"}},
            ],
            initial={"line1": [0, 0, 10, 0]},
        ),
    )

    assert doc["features"][0]["id"] == "sketch1"

    entity_ids = [e["id"] for e in doc["features"][0]["entities"]]
    assert entity_ids == ["line1", "arc1"]

    constraint_ids = [c["id"] for c in doc["features"][0]["constraints"]]
    assert constraint_ids == ["c1"]


def test_parseable_fixture_multiple_features():
    """make_doc accepts multiple features; all IDs are preserved."""
    doc = make_doc(
        make_sketch("sketch1"),
        make_sketch("sketch2", plane="@builtin_plane_top"),
    )

    ids = [f["id"] for f in doc["features"]]
    assert ids == ["sketch1", "sketch2"]


def test_parseable_fixture_does_not_leak_into_yaml():
    """YAML serialisation of a helper-built doc contains no extra metadata.

    The serialised form is structurally identical to a doc built by hand with
    the same IDs -- no display_name, _parseable, or similar keys are injected.
    """
    doc = make_doc(
        make_sketch(
            "sketch1",
            entities=[{"id": "line1", "kind": "line"}],
            constraints=[{"id": "c1", "kind": "horizontal", "target": "$line1"}],
            initial={"line1": [0.0, 0.0, 10.0, 0.0]},
            label="Rectangle",
        ),
    )

    dumped = yaml.dump(doc, default_flow_style=False, allow_unicode=True)
    parsed = yaml.safe_load(dumped)

    feature = parsed["features"][0]
    # Only expected keys are present -- no extra metadata from the helper.
    allowed_keys = {"id", "kind", "plane", "entities", "constraints", "initial", "label"}
    assert set(feature.keys()) <= allowed_keys

    entity = feature["entities"][0]
    allowed_entity_keys = {"id", "kind", "construction", "source"}
    assert set(entity.keys()) <= allowed_entity_keys

    constraint = feature["constraints"][0]
    # The constraint value in this doc is a string, not a nested dict.
    assert constraint["id"] == "c1"
    assert "display_name" not in constraint
    assert "display_name" not in feature
