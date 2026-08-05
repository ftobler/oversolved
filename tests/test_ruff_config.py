"""Guard the local ruff gate against silently diverging from CI's flake8.

The local backend gate runs `ruff check` while CI still runs flake8 with its
default E/F/W rule set. If ruff's config drifts, the local gate weakens without
any CI signal, so this test pins the two to the same line length and rule set.
"""

import pathlib
import tomllib

ROOT = pathlib.Path(__file__).resolve().parent.parent


def load_pyproject() -> dict:
    with open(ROOT / "pyproject.toml", "rb") as f:
        return tomllib.load(f)


def test_ruff_line_length_matches_flake8():
    flake8_section = (ROOT / "setup.cfg").read_text()
    assert "max-line-length = 250" in flake8_section
    assert load_pyproject()["tool"]["ruff"]["line-length"] == 250


def test_ruff_select_covers_flake8_default_rule_families():
    selected = set(load_pyproject()["tool"]["ruff"]["lint"]["select"])
    for family in ("E", "F", "W"):
        assert family in selected, f"ruff select must keep the flake8 {family} family"


def test_local_gate_uses_ruff_but_ci_keeps_flake8():
    justfile = (ROOT / ".justfile").read_text()
    ci = (ROOT / ".github" / "workflows" / "ci.yaml").read_text()
    assert "just ruff" in justfile
    assert "just flake8" not in justfile
    assert "flake8 oversolved tests" in ci
