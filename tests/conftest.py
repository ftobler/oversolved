import os
import pytest
import yaml


OUTPUT_FILE = "frontend/public/test_output/results.yaml"


@pytest.fixture(scope="session")
def sketch_log():
    """Session-scoped logger for tests to record solved sketch results.

    Returns a function that takes (test_name, yaml_str, solve_result) and records it
    for visualization. Written to frontend/public/test_output/results.yaml at session end.
    """
    log = {}

    def log_result(test_name: str, yaml_str: str, solve_result: dict):
        """Log a solve result from a test.

        Args:
            test_name: Name of the test
            yaml_str: The YAML input string (used to extract feature_id)
            solve_result: The result from solve()["result"][feature_id]
        """
        # Extract feature_id from yaml
        doc = yaml.safe_load(yaml_str)
        log[test_name] = {
            "ast_input": doc,
            "solve_result": solve_result
        }
        # features = doc.get("features", [])
        # if features:
        #     feature_id = features[0]["id"]
        #     if test_name not in log:
        #         log[test_name] = {}
        #     log[test_name][feature_id] = solve_result

    # Store log dict as attribute so topology_log can access it (kinda a hack)
    log_result._log = log

    yield log_result

    # Write results to file after all tests complete
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, "w") as f:
        yaml.dump(log, f, default_flow_style=False, allow_unicode=True)


class TopologyLogger:
    """Wrapper for logging topology results that supports both function call and dict assignment."""

    def __init__(self, log: dict):
        self.log = log

    def __call__(self, test_name: str, yaml_str: str, topology_result: dict):
        """Log a topology result from a solver test with spec-compliant format."""
        doc = yaml.safe_load(yaml_str)
        features = doc.get("features", [])
        if features:
            feature_id = features[0]["id"]
            if test_name not in self.log:
                self.log[test_name] = {}
            self.log[test_name][feature_id] = {
                "geometry": {},
                "features": {},
                "status": "fully_constrained",
                "solve_ms": 0,
                "topology": topology_result
            }

    def __setitem__(self, test_name: str, topology_result: dict):
        """Support dict-style assignment for topology-only tests."""
        if test_name not in self.log:
            self.log[test_name] = {}
        self.log[test_name]["topology_test"] = {
            "geometry": {},
            "features": {},
            "status": "fully_constrained",
            "solve_ms": 0,
            "topology": topology_result
        }


@pytest.fixture(scope="session")
def topology_log(sketch_log):
    """Session-scoped fixture for logging topology test results.

    Returns a TopologyLogger that supports both function calls and dict assignment.
    Shares the same log dict with sketch_log.
    """
    return TopologyLogger(sketch_log._log)
