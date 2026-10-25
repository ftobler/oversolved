# justfile
#
# `just` command runner. Targets can be run with `just <target>`.
#
#   everyday   dev, build, static
#   gates      default (python + frontend), python (mypy, ruff, lint-py,
#              pytest), frontend (icons, frontend-lint, frontend-test,
#              licenses, build), rust-test, rust-lint, rust-fmt
#   fuzz       fuzz (the full main-gate suite), fuzz-session, action-matrix,
#              fuzz-geometry, fuzz-sketch
#   assets     wasm, icons
#   setup      install (install-npm, install-wasm, install-occ)
#   cleanup    clean, deepclean
#
# `just fuzz` is the one command for the full main-gate suite locally; the CI
# job calls the same three recipes as separate steps. The fuzz section below
# says what it runs and how fuzz and ratchet differ.
#
# Start here: `just install` once, then `just dev` to run the app. The everyday
# gate is `just default` (Python + frontend).
#
# A bare `just` runs the first recipe, `dev`, not `default`.

# pipefail keeps a recipe's own exit code when it pipes into `tee`, which every
# gate below does; without it the gate would report tee's success instead.
set shell := ["bash", "-cuo", "pipefail"]

# wasm-pack is installed project-local by `install-wasm`, never into ~/.cargo/bin,
# so the asset recipes must invoke it by absolute path to match.
wasm_pack := justfile_directory() / "tmp" / "tools" / "bin" / "wasm-pack"


# ─── everyday ───

# The app is browser-only, so the Vite dev server IS the whole running app:
# storage is IndexedDB, compute is WASM, nothing else needs to be running.

# Run the app (Vite dev server, HMR).
[working-directory: "frontend"]
dev:
    npm run dev

# Build the deployable app into frontend/dist. One build, one artifact: the app
# is static files, so any file server can host it and there is nothing to
# configure per deployment. Assumes public/occ + public/wasm are already
# provisioned by `just install` (occ:provision needs the --no-save
# opencascade.js dep, so it belongs to install, not to every build).

# Build the deployable static app into frontend/dist.
[working-directory: "frontend"]
build:
    mkdir -p ../tmp
    npm run build 2>&1 | tee ../tmp/npm_build.log

# Run `just build` first; this serves the artifact, it does not create it.

# Serve frontend/dist on a plain static server (npx serve, SPA fallback).
static:
    npx --yes serve -s frontend/dist


# ─── gates ───

# Run every gate (Python + frontend).
default:
    mkdir -p tmp
    { just python && just frontend; } 2>&1 | tee tmp/just_default.log

# Every Python gate. No Python runs at app runtime any more, so this covers only
# the repo's own tooling: the icon generator under oversolved/ and the tests
# that pin lint.py's behaviour and the docs/config invariants.

# Every Python gate (mypy + ruff + comment lint + pytest).
python:
    mkdir -p tmp
    { just mypy && just ruff && just lint-py && just pytest; } 2>&1 | tee tmp/just_python.log

# Each gate tees its full output to tmp/<gate>.log as well as stdout. One run is
# slow, so the log lets you re-grep the result afterwards without re-running it.
# Aggregate and asset recipes tee their whole run to tmp/just_<recipe>.log on
# top of that, so `just frontend` needs no hand-written `| tee` to be re-grepped.

# frontend/scripts/ holds two Python files outside the package
# (mergeCorpus.py and cadqueryReference.py), and lint.py is the repo linter, so
# all three are checked alongside the package. CadQuery is imported lazily by
# the reference runner, so mypy sees it without requiring the optional extra.

# Type-check the surviving Python tooling.
mypy:
    mkdir -p tmp
    .venv/bin/python -m mypy tests/ oversolved/ lint.py frontend/scripts/mergeCorpus.py frontend/scripts/cadqueryReference.py 2>&1 | tee tmp/mypy.log

# CI still runs flake8 (same E/F/W rule set) as the safety net.

# Lint the Python tooling with ruff.
ruff:
    mkdir -p tmp
    .venv/bin/python -m ruff check tests/ oversolved/ lint.py frontend/scripts/mergeCorpus.py frontend/scripts/cadqueryReference.py 2>&1 | tee tmp/ruff.log

# lint.py itself is not listed: it holds the rule fixtures and is not a folder.

# Comment-style lint over the repo's Python (dashes, banners).
lint-py:
    mkdir -p tmp
    .venv/bin/python lint.py oversolved tests frontend/scripts --language python 2>&1 | tee tmp/lint_python.log

# Run the Python test suite.
pytest:
    mkdir -p tmp
    .venv/bin/python -m pytest tests/ 2>&1 | tee tmp/pytest.log

# Every frontend gate (icons + lint + tests + licenses + build).
frontend:
    mkdir -p tmp
    { just icons && just frontend-lint && just frontend-test && just licenses && just build; } 2>&1 | tee tmp/just_frontend.log

# Regenerating the notices is a separate, deliberate act
# (npm run licenses:generate).

# Verify the checked-in third-party notice bundles are current.
[working-directory: "frontend"]
licenses:
    mkdir -p ../tmp
    npm run licenses:check 2>&1 | tee ../tmp/licenses_check.log

# ESLint plus the comment-style lint over the frontend TypeScript.
[working-directory: "frontend"]
frontend-lint:
    mkdir -p ../tmp
    npm run lint 2>&1 | tee ../tmp/npm_lint.log
    ../.venv/bin/python ../lint.py src scripts 2>&1 | tee ../tmp/lint_ts.log

# Run the frontend unit tests (vitest, real kernel where provisioned).
[working-directory: "frontend"]
frontend-test:
    mkdir -p ../tmp
    npx vitest run 2>&1 | tee ../tmp/npx_test.log

# ─── fuzz ───

# Fuzz vs ratchet:
#
# A fuzz is a seeded generator plus invariant checks. Four live here: the
# session mutations (`fuzz-session`), the feature chains (`fuzz-geometry`), the
# sketch area builder (`fuzz-sketch`) and the document loader (inside
# `frontend-test`). A ratchet is a committed baseline that fails when it moves:
# the action matrix, the volume oracle, and the pinned seeds of every fuzz.
# These are not two suites: every fuzz is a ratchet, and the matrix and oracle
# are ratchets without a generator.
#
# `just fuzz` is the top-level entry point for a local main-gate run. It runs
# the session fuzz, the action matrix and the geometry fuzz at the sizes main
# runs, in that order, and takes roughly an hour. The CI main-gate job calls
# those three recipes as separate steps so each suite reports its own status
# and duration. The loader fuzz and the volume oracle run in `just frontend-test`;
# the sketch fuzz's PR range runs in `just rust-test`, and `fuzz-sketch`
# harvests wider ranges. A bigger sweep is a sub-recipe call, e.g.
# `just fuzz-session 500 60` or `just fuzz-geometry 5000 4`.

# The full main-gate fuzz suite: session fuzz, action matrix, geometry fuzz.
fuzz:
    mkdir -p tmp
    { just fuzz-session 200 40 && just action-matrix && just fuzz-geometry 1500 4; } 2>&1 | tee tmp/just_fuzz.log

# Seeded mutation and undo/redo fuzz over the mutation registry, driven
# headlessly through DocSession with the real kernel. The PR gate skips the real
# side where it is not provisioned; this recipe sets FUZZ_REQUIRE_REAL so a
# missing build fails instead of passing in seconds on the fake side alone. The
# PR gate runs a bounded 4 seeds x 6 steps; this recipe widens both sides (fake
# and real) and settles every step before asserting its document, idle and
# history-cap invariants. A failing seed is printed by number and can be
# replayed alone.

# Seeded mutation and undo/redo fuzz (real kernel required).
[working-directory: "frontend"]
fuzz-session seeds="200" steps="40":
    mkdir -p ../tmp
    FUZZ_REQUIRE_REAL=1 FUZZ_SEEDS={{seeds}} FUZZ_STEPS={{steps}} FUZZ_FAKE_SEEDS={{seeds}} FUZZ_FAKE_STEPS={{steps}} npx vitest run src/hooks/__tests__/fuzz.test.ts 2>&1 | tee ../tmp/fuzz_session.log

# The full action-matrix sweep: every part command on every target of every
# corpus document (the regression baseline plus the doc-shaped fixtures),
# compared exactly against the committed baseline. The real kernel runs where
# provisioned (the fake scheduler otherwise; a command's status cannot depend on
# the scheduler), and the run takes minutes, so it is a main-gate, not a PR-gate,
# cost. The PR gate keeps the bounded smoke slices. Regenerate the baseline with
# `npm run regen:action-matrix` from frontend/.

# Full action-matrix sweep against the committed baseline.
[working-directory: "frontend"]
action-matrix:
    mkdir -p ../tmp
    ACTION_MATRIX_FULL=1 npx vitest run src/testing/actionMatrix/actionMatrixReal.test.ts 2>&1 | tee ../tmp/action_matrix.log

# The geometry fuzz: random realistic feature chains and primitive boolean
# pairs against the real kernel, checked after every step (validity, volume,
# cut/join monotonicity), plus pick persistence under a small upstream dimension
# change. Every replay runs in a forked child under a SIGKILL watchdog,
# scheduled through a bounded pool (ROBUSTNESS_FUZZ_WORKERS), so a hung OCC
# clean is reported with its seed and step instead of wedging the run (the
# browser worker keeps the same 30 s kill for the same reason: see
# frontend/src/testing/robustnessFuzz/chainTimeout.ts). Each chain child holds
# its own ~0.75 GB OCC kernel, so the pool defaults to 2 and the vitest forks
# are pinned to 1: the two suites run in sequence instead of two extra kernels
# deep. The main gate passes 4 (about 3 GB of kernels, inside the CI runner's
# 8 GB share); raise it further on a wide, memory-rich box. The PR suite
# runs a bounded 24-chain-seed range and its identity sweep derives a quarter of
# this one. The default 200 is the plan's acceptance range; the main gate runs
# 1500; 5000 is the plan's dedicated full scale.

# Seeded feature chains and primitive boolean pairs against the real kernel.
[working-directory: "frontend"]
fuzz-geometry seeds="200" workers="2":
    mkdir -p ../tmp
    VITEST_MAX_FORKS=1 ROBUSTNESS_FUZZ_WORKERS={{workers}} ROBUSTNESS_FUZZ_SEEDS={{seeds}} npx vitest run src/testing/robustnessFuzz 2>&1 | tee ../tmp/fuzz_geometry.log

# The long area-builder fuzz: seeds <from>..<to> through the motif generator and
# the invariant oracle, judged against the per-seed catalogue in fuzz/tests.rs.
# Every new coverage/structure/euler failure is minimised into
# sketch-solver/src/topology/dcel/tests/fuzz_cases/ and every new failure's
# catalogue entry is printed for review; stability and order are
# catalogue-only. The PR gate already runs seeds 0..300 inside `just rust-test`;
# this is the harvesting sweep, so review what it writes before committing.

# Harvesting area-builder fuzz over seeds <from>..<to> (writes fuzz_cases/).
fuzz-sketch from to:
    mkdir -p tmp
    SKETCH_FUZZ_FROM={{from}} SKETCH_FUZZ_TO={{to}} SKETCH_FUZZ_WRITE=1 cargo test -p sketch-solver --lib topology::fuzz::tests::fuzz_range_from_env -- --ignored --nocapture 2>&1 | tee tmp/fuzz_sketch.log

# Old names, kept for scripts and notes written before the fuzz naming cleanup.
# Hidden from `just --list`; new work should use the names above.

# Deprecated alias for `action-matrix`.
[private]
ratchet-matrix:
    @just action-matrix

# Deprecated alias for `fuzz-geometry`.
[private]
robustness-fuzz seeds="200" workers="2":
    @just fuzz-geometry {{seeds}} {{workers}}

# Deprecated alias for `fuzz-sketch`.
[private]
sketch-fuzz from to:
    @just fuzz-sketch {{from}} {{to}}


# ─── rust ───

# Test the Rust solver workspace (solver-core + sketch-solver + mate-solver).
rust-test:
    mkdir -p tmp
    cargo test --workspace 2>&1 | tee tmp/cargo_test.log

# Lint the Rust solver workspace (clippy incl. tests, deny warnings, comment lint).
rust-lint:
    mkdir -p tmp
    cargo clippy --workspace --tests -- -D warnings 2>&1 | tee tmp/cargo_clippy.log
    .venv/bin/python lint.py solver-core sketch-solver mate-solver --language rust 2>&1 | tee tmp/lint_rust.log

# Check Rust formatting without rewriting files; CI runs the same command.
rust-fmt:
    mkdir -p tmp
    cargo fmt --all --check 2>&1 | tee tmp/cargo_fmt.log


# ─── assets ───

# Build both Rust solvers to WASM (web target for frontend + nodejs target for
# tests). Two crates, two binaries: the sketch/OCC worker and the anchor solver
# worker each load only their own. See the workspace root Cargo.toml.

# The sketch-solver nodejs target carries `--features fuzz`: sketchRepros.test.ts
# drives the fuzz-gated oracle export and must not skip in a provisioned tree.
# The web target and the other three builds stay feature-free (the production
# WASM binary never pays for the oracle).

# Build both Rust solvers to WASM and copy them into the frontend.
wasm:
    mkdir -p tmp
    { \
        (cd sketch-solver && {{wasm_pack}} build --target web --out-dir pkg --release) && \
        (cd sketch-solver && {{wasm_pack}} build --target nodejs --out-dir pkg-node --release -- --features fuzz) && \
        (cd mate-solver && {{wasm_pack}} build --target web --out-dir pkg --release) && \
        (cd mate-solver && {{wasm_pack}} build --target nodejs --out-dir pkg-node --release) && \
        (cd frontend && node scripts/copyWasm.mjs); \
    } 2>&1 | tee tmp/wasm.log

# Regenerate the icon set from oversolved/icons.py.
icons:
    mkdir -p tmp
    .venv/bin/python oversolved/icons.py 2>&1 | tee tmp/icons.log


# ─── setup ───

# The solver build is not optional for the gates: without pkg-node every
# real-kernel suite skips silently.

# Install all dependencies (Python + frontend + wasm tools + solver build + opencascade.js).
install:
    mkdir -p tmp
    # note cairo needs apt libcairo2-dev
    { \
        (test -d .venv || python3 -m venv .venv) && \
        .venv/bin/pip install -e ".[dev,cadquery]" && \
        just install-npm && \
        just install-wasm && \
        just wasm && \
        just install-occ; \
    } 2>&1 | tee tmp/just_install.log

# Install the frontend npm dependencies.
[working-directory: "frontend"]
install-npm:
    mkdir -p ../tmp
    npm install 2>&1 | tee ../tmp/npm_install.log

# wasm-pack is installed project-local so nothing leaks into ~/.cargo/bin.
# --locked builds from wasm-pack's own Cargo.lock: a fresh resolve fails since
# every zip 2.x (pulled in by binary-install) was yanked, a lockfile still may pin one.

# Install the wasm build tool into tmp/tools.
install-wasm:
    mkdir -p tmp
    cargo install wasm-pack --version 0.15.0 --locked --root tmp/tools 2>&1 | tee tmp/cargo_install_wasm_pack.log

# Install opencascade.js (--no-save) and provision it into public/occ.
[working-directory: "frontend"]
install-occ:
    mkdir -p ../tmp
    { npm run occ:install && npm run occ:provision; } 2>&1 | tee ../tmp/occ_install.log


# ─── cleanup ───

# Remove build artifacts (keeps .venv and node_modules).
clean:
    find . -type d \( -name __pycache__ -o -name .pytest_cache -o -name .mypy_cache -o -name .ruff_cache \) -exec rm -rf {} + 2>/dev/null; true
    find . -name '*.pyc' -delete
    rm -rf *.egg-info dist build
    rm -rf sketch-solver/pkg sketch-solver/pkg-node
    rm -rf mate-solver/pkg mate-solver/pkg-node
    rm -rf frontend/dist frontend/public/wasm frontend/public/occ

# Remove everything above plus venv and node_modules.
deepclean:
    just clean
    rm -rf .venv
    rm -rf frontend/node_modules
