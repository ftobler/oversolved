"""Regression guards for docs/tooling accuracy (review-18 AR findings).

These pin the doc/tooling invariants that the autonomous review caught as
stale or misleading, so a future drift re-fails here instead of silently
misleading a developer.
"""

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent


def _read(rel: str) -> str:
    return (ROOT / rel).read_text()


def test_env_example_has_no_dead_db_path_var() -> None:
    # AR-M1: OVERSOLVED_DB_PATH is never read; the SQLite path is a CLI flag.
    text = _read(".env.example")
    assert "OVERSOLVED_DB_PATH" not in text


def test_frontend_package_json_declares_node_floor() -> None:
    # AR-L1: pin the Node floor Vite 8 actually requires.
    pkg = json.loads(_read("frontend/package.json"))
    assert pkg.get("engines", {}).get("node") == ">=20.19.0"


def test_runtime_config_cites_real_just_target() -> None:
    # AR-L6: the build target is `just build`, not `just buildstatic`.
    text = _read("frontend/public/runtime-config.js")
    assert "just buildstatic" not in text
    assert "just build" in text


def test_code_guideline_uses_draw_all_not_drawall() -> None:
    # AR-N1: the icon render entry point is `draw_all()`, not `drawall()`.
    text = _read("code_guideline.md")
    assert "drawall()" not in text
    assert "draw_all()" in text


def test_setup_doc_states_node_floor() -> None:
    # AR-N (stale floor): Node.js >= 18 no longer builds with Vite 8.
    text = _read("docs/setup.md")
    assert "Node.js >= 20.19" in text


def test_setup_doc_mypy_command_matches_canonical_order() -> None:
    # AR-N: the canonical mypy invocation is `tests/ oversolved/`.
    text = _read("docs/setup.md")
    assert "mypy tests/ oversolved/" in text


def test_lint_py_docstring_points_at_real_convention_doc() -> None:
    # Tooling drift: lint.py described its rules as living in CLAUDE.md, which
    # does not exist; they live in AGENTS.md.
    text = _read("lint.py")
    assert "CLAUDE.md" not in text
    assert "AGENTS.md" in text
