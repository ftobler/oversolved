import json
import os
import pytest


OUTPUT_FILE = "frontend/public/test_output/results.json"


@pytest.fixture(scope="session")
def sketch_log():
    """Session-scoped dict for tests to record solved sketch geometry.

    Written to frontend/public/test_output/results.json at session end
    so the frontend visualizer can load it.
    """
    log = {}
    yield log
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, "w") as f:
        json.dump(log, f, indent=2)
