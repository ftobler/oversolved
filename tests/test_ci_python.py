"""One Python version across CI, pinned to the declared floor.

The `python` job used to carry a 3.12/3.13/3.14 matrix. Python is build-time
tooling only (no runtime, no distributed package), so the matrix promised
support nobody consumes while the version everyone develops on was covered
only by accident. Every workflow now pins one literal interpreter, the version
the local .venv comes from, and these guards keep the pins from drifting apart
or away from `pyproject.toml`'s floor.
"""

import pathlib
import re
import tomllib

ROOT = pathlib.Path(__file__).resolve().parent.parent

WORKFLOWS = (
    ".github/workflows/ci-gitea.yaml",
    ".github/workflows/ci-github.yaml",
    ".github/workflows/pages-github.yaml",
)

_PIN = re.compile(r"^\s*python-version:\s*(.+?)\s*$")
# A literal quoted or bare version. A flow list (the old matrix) and a
# `${{ matrix.python-version }}` expression both fail to match on purpose.
_LITERAL = re.compile(r'^"?(\d+\.\d+)"?$')
# The floor form pyproject must declare: one >=X.Y, no upper bound.
_FLOOR = re.compile(r"^>=\s*(\d+\.\d+)$")


def _pins(rel: str) -> list[str]:
    values: list[str] = []
    for line in (ROOT / rel).read_text().splitlines():
        match = _PIN.match(line)
        if match is None:
            continue
        value = match.group(1).split("#", 1)[0].strip()
        literal = _LITERAL.match(value)
        assert literal is not None, (
            f"{rel}: python-version is {value!r}; every workflow pins one literal "
            "version, never a matrix expression or a version list"
        )
        values.append(literal.group(1))
    return values


def _sole_ci_version() -> str:
    versions = {version for rel in WORKFLOWS for version in _pins(rel)}
    assert len(versions) == 1, (
        "the workflows no longer share one Python version: "
        + ", ".join(f"{rel}={sorted(set(_pins(rel)))}" for rel in WORKFLOWS)
    )
    return next(iter(versions))


def test_every_workflow_pins_the_same_python_version() -> None:
    for rel in WORKFLOWS:
        assert _pins(rel), f"{rel} sets no python-version; the check would silently skip it"
    _sole_ci_version()


def test_ci_python_matches_the_requires_python_floor() -> None:
    version = _sole_ci_version()
    requires_python = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]["requires-python"]
    floor = _FLOOR.match(requires_python.strip())
    assert floor is not None, f"requires-python is {requires_python!r}; expected a single >=X.Y floor"
    assert floor.group(1) == version, (
        f"pyproject declares requires-python {requires_python!r} but CI tests {version}; "
        "the declared floor and the tested version move together"
    )
