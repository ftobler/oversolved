# justfile
#
# `just` command runner. Targets can be run with `just <target>`.
#
#   everyday   dev, build, static
#   gates      default (python + frontend), python, frontend, rust-test,
#              rust-lint, rust-fmt, licenses
#   assets     wasm, icons
#   setup      install
#   cleanup    clean, deepclean

# pipefail keeps a recipe's own exit code when it pipes into `tee`, which every
# gate below does; without it the gate would report tee's success instead.
set shell := ["bash", "-cuo", "pipefail"]

# wasm-pack is installed project-local by `install-wasm`, never into ~/.cargo/bin,
# so the asset recipes must invoke it by absolute path to match.
wasm_pack := justfile_directory() / "tmp" / "tools" / "bin" / "wasm-pack"


# --- everyday ---

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


# --- gates ---

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

# frontend/scripts/mergeCorpus.py is the one Python file outside the package,
# and lint.py is the repo linter, so both are checked alongside the package.

# Type-check the surviving Python tooling.
mypy:
    mkdir -p tmp
    .venv/bin/python -m mypy tests/ oversolved/ lint.py frontend/scripts/mergeCorpus.py 2>&1 | tee tmp/mypy.log

# local ruff gate; CI still runs flake8 (same E/F/W rule set) as the safety net
ruff:
    mkdir -p tmp
    .venv/bin/python -m ruff check tests/ oversolved/ lint.py frontend/scripts/mergeCorpus.py 2>&1 | tee tmp/ruff.log

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

[working-directory: "frontend"]
frontend-lint:
    mkdir -p ../tmp
    npm run lint 2>&1 | tee ../tmp/npm_lint.log
    ../.venv/bin/python ../lint.py src scripts 2>&1 | tee ../tmp/lint_py.log

[working-directory: "frontend"]
frontend-test:
    mkdir -p ../tmp
    npx vitest run 2>&1 | tee ../tmp/npx_test.log

# Long seeded fuzz run: random mutation and undo/redo sequences over the
# mutation registry, driven headlessly through DocSession with the real kernel
# when installed. The PR gate runs a bounded 4 seeds x 6 steps; this recipe
# widens both sides (fake and real) and settles every step before asserting its
# document, idle and history-cap invariants. `just fuzz 500 60` for a bigger
# sweep; a failing seed is printed by number and can be replayed alone.
[working-directory: "frontend"]
fuzz seeds="200" steps="40":
    mkdir -p ../tmp
    FUZZ_SEEDS={{seeds}} FUZZ_STEPS={{steps}} FUZZ_FAKE_SEEDS={{seeds}} FUZZ_FAKE_STEPS={{steps}} npx vitest run src/hooks/__tests__/fuzz.test.ts 2>&1 | tee ../tmp/fuzz.log

# The full action-matrix sweep: every part command on every target of all 72
# corpus documents, compared exactly against the committed baseline. The real
# kernel runs where provisioned (the fake scheduler otherwise; a command's
# status cannot depend on the scheduler), and the run takes minutes, so it is a
# nightly, not a PR-gate, cost. The PR gate keeps the bounded smoke slices.
# Regenerate the baseline with `npm run regen:action-matrix` from frontend/.
[working-directory: "frontend"]
ratchet-matrix:
    mkdir -p ../tmp
    ACTION_MATRIX_FULL=1 npx vitest run src/testing/actionMatrix/actionMatrixReal.test.ts 2>&1 | tee ../tmp/action_matrix.log

# The geometry robustness fuzz: random realistic feature chains and primitive
# boolean pairs against the real kernel, checked after every step (validity,
# volume, cut/join monotonicity), plus pick persistence under a small upstream
# dimension change. Every replay runs in a forked child under a SIGKILL
# watchdog, scheduled through a bounded pool (ROBUSTNESS_FUZZ_WORKERS, default
# 2), so a hung OCC clean is reported with its seed and step instead of wedging
# the run (the browser worker keeps the same 30 s kill for the same reason: see
# frontend/src/testing/robustnessFuzz/chainTimeout.ts). Each chain child holds
# its own ~0.75 GB OCC kernel, so this recipe pins the pool to 2 and the vitest
# forks to 1: the two suites run in sequence instead of two extra kernels deep
# (raise workers on a wide, memory-rich box, not on the nightly runner). The PR
# suite runs a bounded 24-chain-seed range and its identity sweep derives a
# quarter of this one (the default 200 is the plan's acceptance range; the
# nightly runs 1500 and `just robustness-fuzz 5000` is the plan's full scale).
[working-directory: "frontend"]
robustness-fuzz seeds="200" workers="2":
    mkdir -p ../tmp
    VITEST_MAX_FORKS=1 ROBUSTNESS_FUZZ_WORKERS={{workers}} ROBUSTNESS_FUZZ_SEEDS={{seeds}} npx vitest run src/testing/robustnessFuzz 2>&1 | tee ../tmp/robustness_fuzz.log

# Test the Rust solver workspace (solver-core + sketch-solver + mate-solver)
rust-test:
    mkdir -p tmp
    cargo test --workspace 2>&1 | tee tmp/cargo_test.log

# Lint the Rust solver workspace (clippy incl. tests, deny warnings)
rust-lint:
    mkdir -p tmp
    cargo clippy --workspace --tests -- -D warnings 2>&1 | tee tmp/cargo_clippy.log
    .venv/bin/python lint.py solver-core sketch-solver mate-solver --language rust 2>&1 | tee tmp/lint_rust.log

# Check Rust formatting without rewriting files; CI runs the same command.
rust-fmt:
    mkdir -p tmp
    cargo fmt --all --check 2>&1 | tee tmp/cargo_fmt.log

# Long area-builder fuzz run: seeds <from>..<to> through the motif generator and
# the invariant oracle, with every new untagged failure minimised into
# sketch-solver/src/topology/dcel/tests/fuzz_cases/ for review. The PR gate
# already runs seeds 0..300 inside `just rust-test`; this is the harvesting
# sweep, so it keeps the cases it writes (review, then commit them with the
# findings they belong to).
sketch-fuzz from to:
    mkdir -p tmp
    SKETCH_FUZZ_FROM={{from}} SKETCH_FUZZ_TO={{to}} SKETCH_FUZZ_WRITE=1 cargo test -p sketch-solver --lib topology::fuzz::tests::fuzz_range_from_env -- --ignored --nocapture 2>&1 | tee tmp/sketch_fuzz.log


# --- assets ---

# Build both Rust solvers to WASM (web target for frontend + nodejs target for
# tests). Two crates, two binaries: the sketch/OCC worker and the anchor solver
# worker each load only their own. See the workspace root Cargo.toml.

# Build both Rust solvers to WASM and copy them into the frontend. The
# sketch-solver nodejs target carries `--features fuzz`: sketchRepros.test.ts
# drives the fuzz-gated oracle export and must not skip in a provisioned tree.
# The web target and the other three builds stay feature-free (the production
# WASM binary never pays for the oracle).
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


# --- setup ---

# Install all dependencies (Python + frontend + wasm tools + opencascade.js)
install:
    mkdir -p tmp
    # note cairo needs apt libcairo2-dev
    { \
        (test -d .venv || python3 -m venv .venv) && \
        .venv/bin/pip install -e ".[dev]" && \
        just install-npm && \
        just install-wasm && \
        just install-occ; \
    } 2>&1 | tee tmp/just_install.log

[working-directory: "frontend"]
install-npm:
    mkdir -p ../tmp
    npm install 2>&1 | tee ../tmp/npm_install.log

# wasm-pack is installed project-local so nothing leaks into ~/.cargo/bin.

# Install the wasm build tool into tmp/tools.
install-wasm:
    mkdir -p tmp
    cargo install wasm-pack --root tmp/tools 2>&1 | tee tmp/cargo_install_wasm_pack.log

[working-directory: "frontend"]
install-occ:
    mkdir -p ../tmp
    { npm run occ:install && npm run occ:provision; } 2>&1 | tee ../tmp/occ_install.log


# --- cleanup ---

# Remove build artifacts (keeps .venv and node_modules)
clean:
    find . -type d \( -name __pycache__ -o -name .pytest_cache -o -name .mypy_cache -o -name .ruff_cache \) -exec rm -rf {} + 2>/dev/null; true
    find . -name '*.pyc' -delete
    rm -rf *.egg-info dist build
    rm -rf sketch-solver/pkg sketch-solver/pkg-node
    rm -rf mate-solver/pkg mate-solver/pkg-node
    rm -rf frontend/dist frontend/public/wasm frontend/public/occ

# Remove everything above plus venv and node_modules
deepclean:
    just clean
    rm -rf .venv
    rm -rf frontend/node_modules
