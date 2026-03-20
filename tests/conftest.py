import os
import pytest
import yaml


OUTPUT_FILE = "frontend/public/test_output/results.yaml"


@pytest.fixture(scope="session")
def sketch_log():
    """Session-scoped dict for tests to record solved sketch geometry.

    Written to frontend/public/test_output/results.yaml at session end
    so the frontend visualizer can load it.
    """
    log = {}
    yield log
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, "w") as f:
        yaml.dump(log, f, default_flow_style=False, allow_unicode=True)
