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


class TopologyLogger:
    """Helper to log topology results in visualizer-compatible format."""

    def __init__(self, log: dict):
        self.log = log

    def __setitem__(self, test_name: str, topology_result: dict):
        """Log a topology result wrapped in the expected feature structure."""
        self.log[test_name] = {
            "topology_test": {
                "geometry": {"initial": {}, "solved": {}},
                "constraints": {},
                "entity_status": {},
                "status": "fully_constrained",
                "solve_ms": 0,
                "topology": topology_result
            }
        }


@pytest.fixture(scope="session")
def topology_log(sketch_log):
    """Session-scoped fixture for logging topology test results.

    Wraps topology data in the visualizer-compatible format and merges
    into the main sketch_log for output.
    """
    return TopologyLogger(sketch_log)
