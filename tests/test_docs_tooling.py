"""Regression guards for docs/tooling accuracy (review-18 AR findings).

These pin the doc/tooling invariants that the autonomous review caught as
stale or misleading, so a future drift re-fails here instead of silently
misleading a developer.
"""

import json
import pathlib
import re

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent


def _read(rel: str) -> str:
    return (ROOT / rel).read_text()


def _squashed(text: str) -> str:
    """Prose wrapped at 80 columns, so compare after collapsing whitespace."""
    return " ".join(text.split())


def _mutation_example_count() -> int:
    text = _read("frontend/src/hooks/__tests__/mutationExamples.ts")
    start = text.index("export const MUTATION_EXAMPLES")
    end = text.index("\n}", start)
    return len(re.findall(r"^  [a-z][a-z0-9_]*: \{", text[start:end], re.M))


def _action_matrix() -> dict:
    return json.loads(_read("frontend/src/testing/actionMatrix/baseline.json"))


def _oracle_case_count() -> int:
    return sum(1 for path in (ROOT / "frontend" / "oracle").iterdir() if path.is_dir() and re.match(r"\d\d-", path.name))


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
    "docs/testing.md",
    "justfile",
    "pyproject.toml",
    ".github/workflows/ci-gitea.yaml",
    ".github/workflows/ci-github.yaml",
    ".github/workflows/pages-github.yaml",
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


def test_main_gate_is_named_fuzz_not_nightly() -> None:
    """The long suite is the `fuzz` job on `refs/heads/main` and `refs/heads/fuzz`.

    It was called nightly before 83c82d2e; the schedule is gone. Prose that
    still says nightly sends the next reader looking for a job that does not
    exist. The job calls the three sweeps as separate steps so a failure and
    its duration are attributable without reading the aggregate log.
    """
    for rel in ("AGENTS.md", "docs/testing.md", ".github/workflows/ci-gitea.yaml"):
        assert "nightly" not in _read(rel).lower(), (
            f"{rel} calls the main-gate suite nightly; it is the `fuzz` job, "
            "gated to refs/heads/main and refs/heads/fuzz."
        )
    ci = _read(".github/workflows/ci-gitea.yaml")
    start = ci.index("  fuzz:")
    body = ci[start:].split("\n  #", 1)[0]
    assert "refs/heads/main" in body and "refs/heads/fuzz" in body, (
        "the fuzz job is no longer gated to both refs/heads/main and refs/heads/fuzz"
    )
    comment = ci[ci.rindex("\n\n", 0, start) + 2:start]
    assert "on main only" not in comment, (
        "the fuzz job's leading comment still says main only; it runs on refs/heads/main or refs/heads/fuzz"
    )
    for command in (
        "run: just fuzz-session 200 40",
        "run: just action-matrix",
        "run: just fuzz-geometry 1500 4",
    ):
        assert command in body, f"the fuzz job no longer runs `{command}` as its own step"


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


def test_setup_doc_quotes_the_mypy_recipe() -> None:
    # AR-N: the canonical type-check is `just mypy`. A quoted bare command
    # drifted once already (it missed frontend/scripts/cadqueryReference.py),
    # so the doc points at the recipe and the target list lives in the justfile.
    text = _read("docs/setup.md")
    assert "just mypy" in text
    assert "just python" in text
    assert "mypy tests/ oversolved/" not in text


def test_lint_py_docstring_points_at_real_convention_doc() -> None:
    # Tooling drift: lint.py described its rules as living in CLAUDE.md, which
    # does not exist; they live in AGENTS.md.
    text = _read("lint.py")
    assert "CLAUDE.md" not in text
    assert "AGENTS.md" in text


def test_fuzz_geometry_recipe_requires_a_real_kernel() -> None:
    """An unprovisioned tree must fail `just fuzz-geometry`, not skip it.

    Every robustness suite is skipIf(!occAvailable); the recipe therefore has
    to ask for the real kernel explicitly, or the main gate can report a green
    geometry sweep that never built anything.
    """
    justfile = _read("justfile")
    start = justfile.index("fuzz-geometry seeds=")
    body = justfile[start:].split("\n\n", 1)[0]
    assert "FUZZ_REQUIRE_REAL=1" in body, "the fuzz-geometry recipe no longer requires the real kernel"
    assert "KERNEL_PROVISIONED=1" in body, "the fuzz-geometry recipe no longer arms the provisioning guards"


def test_ci_fuzz_job_requires_a_real_kernel() -> None:
    ci = _read(".github/workflows/ci-gitea.yaml")
    start = ci.index("  fuzz:")
    body = ci[start:].split("\n  #", 1)[0]
    assert 'KERNEL_PROVISIONED: "1"' in body
    assert 'FUZZ_REQUIRE_REAL: "1"' in body


def test_frontend_lint_scans_the_root_configs() -> None:
    """The root configs sit beside src/ and scripts/, so the folders alone miss
    them; the recipe and CI name them explicitly."""
    justfile = _read("justfile")
    start = justfile.index("frontend-lint:")
    body = justfile[start:].split("\n\n", 1)[0]
    for name in ("eslint.config.js", "resolve-alias.loader.mjs", "vite.config.ts", "vitest.config.ts"):
        assert name in body, f"frontend-lint no longer lints {name}"
    for rel in (".github/workflows/ci-gitea.yaml", ".github/workflows/ci-github.yaml"):
        assert "frontend/eslint.config.js" in _read(rel), f"{rel} no longer lints the frontend root configs"


def test_testing_doc_action_matrix_counts_match_the_baseline() -> None:
    """Hand-written counts are what drifted; derive them from the baseline."""
    baseline = _action_matrix()
    sweep = baseline["sweep"]
    phrase = (
        f"{sweep['docs']} documents x up to {sweep['maxTargetsPerDoc']} targets "
        f"x {sweep['commands']} commands, {len(baseline['rows']):,} rows"
    )
    assert phrase in _squashed(_read("docs/testing.md")), (
        f"docs/testing.md no longer states the live matrix sweep ({phrase}); "
        "regenerate the baseline and update the prose together"
    )


def test_testing_doc_part_spec_count_matches_the_matrix() -> None:
    commands = _action_matrix()["sweep"]["commands"]
    phrase = f"(the sketch/part editor, {commands} specs)"
    assert phrase in _squashed(_read("docs/command_system.md")), (
        f"docs/command_system.md no longer states `{phrase}`; the sweep enumerates PART_COMMAND_SPECS"
    )


def test_testing_doc_session_fuzz_count_matches_the_registry() -> None:
    count = _mutation_example_count()
    phrase = f"over the {count}-type mutation example registry"
    assert phrase in _squashed(_read("docs/testing.md")), (
        f"docs/testing.md no longer states `{phrase}`; update it with MUTATION_EXAMPLES"
    )


def test_testing_doc_ci_fuzz_size_and_branches_match_the_workflow() -> None:
    ci = _read(".github/workflows/ci-gitea.yaml")
    start = ci.index("  fuzz:")
    body = ci[start:].split("\n  #", 1)[0]
    assert "refs/heads/main" in body and "refs/heads/fuzz" in body
    assert "run: just fuzz-session 200 40" in body
    assert "run: just fuzz-geometry 1500 4" in body
    doc = _squashed(_read("docs/testing.md"))
    assert "`refs/heads/main` or `refs/heads/fuzz`" in doc, "docs/testing.md lost the fuzz branch from the CI gate"
    assert "just fuzz-session 200 40" in doc, "docs/testing.md no longer states the main-gate session size"
    assert "just fuzz-geometry 1500 4" in doc, "docs/testing.md no longer states the main-gate geometry size"


def test_testing_doc_node_matrix_matches_ci() -> None:
    for rel in (".github/workflows/ci-gitea.yaml", ".github/workflows/ci-github.yaml"):
        ci = _read(rel)
        matrix = re.search(r"node-version: \[([^\]]+)\]", ci)
        assert matrix is not None, f"{rel} lost its Node matrix"
        versions = [part.strip() for part in matrix.group(1).split(",")]
        assert versions == ["22", "24", "26"], f"the Node matrix in {rel} moved to {versions}"
    doc = _squashed(_read("docs/testing.md"))
    assert "the matrix runs 22, 24 and 26" in doc, (
        "docs/testing.md no longer states the CI Node matrix; it must not claim a leg below 22.6"
    )
    assert "no CI leg is that old" in doc


def test_testing_doc_regressions_replay_matches_the_suite() -> None:
    suite = _read("frontend/src/testing/robustnessFuzz/regressionsReal.test.ts")
    assert re.search(r"endsWith\(\s*['\"]-minimal\.json['\"]\s*\)", suite), (
        "the fixture replay suite stopped reading *-minimal.json"
    )
    doc = _squashed(_read("docs/testing.md"))
    assert "nothing replays the directory yet" not in doc, (
        "regressionsReal.test.ts replays every *-minimal.json fixture on the PR gate"
    )
    assert "regressionsReal.test.ts" in doc and "replays every `*-minimal.json`" in doc


def test_kb_counts_match_the_live_files() -> None:
    """The knowledge base lives in the separate feature/ repo; skip without it."""
    path = ROOT / "feature" / "knowledgebase.agent.md"
    if not path.is_file():
        pytest.skip("feature/knowledgebase.agent.md is absent (feature/ is a separate, gitignored repo)")
    text = _squashed(path.read_text())
    count = _mutation_example_count()
    assert f"the {count}-type mutation example registry" in text, (
        f"the knowledge base no longer states the live MUTATION_EXAMPLES count ({count})"
    )
    cases = _oracle_case_count()
    assert f"({cases} recipe parts" in text, (
        f"the knowledge base no longer states the live oracle case count ({cases})"
    )
    assert "refs/heads/main` or `refs/heads/fuzz" in text, (
        "the knowledge base lost the fuzz branch from the main-gate job gate"
    )
