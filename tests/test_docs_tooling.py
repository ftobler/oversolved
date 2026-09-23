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


# AR-M1 originally guarded one dead variable (OVERSOLVED_DB_PATH) in
# .env.example. The server teardown deleted that file along with every variable
# it described, so the guard is widened rather than dropped: the failure mode it
# caught -- documenting configuration nothing reads -- now applies to the whole
# surviving doc and tooling surface.
DEAD_SERVER_ENV_VARS = (
    "OVERSOLVED_DB_PATH",
    "OVERSOLVED_DB_DSN",
    "TEST_DB_DSN",
    "OVERSOLVED_ADMIN_PASSWORD",
    "OVERSOLVED_SESSION_COOKIE_SECURE",
    "OVERSOLVED_UPLOAD_DIR",
    "SOLVER_DAEMON_HOST",
    "GUNICORN_WORKERS",
)

DOC_AND_TOOLING_SURFACE = (
    "AGENTS.md",
    "code_guideline.md",
    "docs/setup.md",
    "justfile",
    "pyproject.toml",
    ".github/workflows/ci.yaml",
)


def test_no_dead_server_env_vars_are_documented() -> None:
    stale = []
    for rel in DOC_AND_TOOLING_SURFACE:
        text = _read(rel)
        stale += [f"{rel}: {var}" for var in DEAD_SERVER_ENV_VARS if var in text]
    assert not stale, (
        "the app is browser-only; these variables configure a server that no "
        "longer exists:\n" + "\n".join(stale)
    )


def test_env_example_is_gone() -> None:
    # Every variable it held configured the deleted Flask/Postgres stack, and a
    # browser-only app reads no environment at runtime at all.
    assert not (ROOT / ".env.example").exists()


def test_frontend_package_json_declares_node_floor() -> None:
    # AR-L1: pin the Node floor Vite 8 actually requires.
    pkg = json.loads(_read("frontend/package.json"))
    assert pkg.get("engines", {}).get("node") == ">=20.19.0"


def test_runtime_config_file_is_gone() -> None:
    """The per-deployment backend flag file must not come back.

    It existed to tell one app bundle whether a Flask backend was in front of
    it. With the server gone there is one build and one behaviour, so a
    runtime-config.js reappearing would mean a deployment fork reappeared with
    it -- and the file is loaded by a blocking script tag in index.html, so it
    would be doing that invisibly, before any test-covered code runs.
    """
    assert not (ROOT / "frontend/public/runtime-config.js").exists()
    assert not (ROOT / "frontend/scripts/writeRuntimeConfig.mjs").exists()
    assert "runtime-config" not in _read("frontend/index.html")


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
