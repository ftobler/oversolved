# justfile
#
# `just` command runner. Targets can be run with `just <target>`.
#
#   everyday   dev, build, static
#   gates      default (python + frontend), python, frontend, rust-test,
#              rust-lint, rust-fmt, licenses, parity
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

# Every Python gate (mypy + ruff + pytest).
python:
    mkdir -p tmp
    { just mypy && just ruff && just pytest; } 2>&1 | tee tmp/just_python.log

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

# Full-document WASM parity gate (TS kernel vs frozen baseline). Slow, needs
# OCC.js provisioned, hard-fails on any divergence. Kept out of `just frontend`.

# Full-document WASM parity gate against the frozen baseline. Slow.
[working-directory: "frontend"]
parity:
    mkdir -p ../tmp
    just install-occ
    npm run test:parity 2>&1 | tee ../tmp/parity.log

# Test the Rust solver workspace (solver-core + sketch-solver + mate-solver)
rust-test:
    mkdir -p tmp
    cargo test --workspace 2>&1 | tee tmp/cargo_test.log

# Lint the Rust solver workspace (clippy, deny warnings)
rust-lint:
    mkdir -p tmp
    cargo clippy --workspace -- -D warnings 2>&1 | tee tmp/cargo_clippy.log
    .venv/bin/python lint.py solver-core sketch-solver mate-solver --language rust 2>&1 | tee tmp/lint_rust.log

# Check Rust formatting without rewriting files; CI runs the same command.
rust-fmt:
    mkdir -p tmp
    cargo fmt --all --check 2>&1 | tee tmp/cargo_fmt.log


# --- assets ---

# Build both Rust solvers to WASM (web target for frontend + nodejs target for
# tests). Two crates, two binaries: the sketch/OCC worker and the anchor solver
# worker each load only their own. See the workspace root Cargo.toml.

# Build both Rust solvers to WASM and copy them into the frontend.
wasm:
    mkdir -p tmp
    { \
        (cd sketch-solver && {{wasm_pack}} build --target web --out-dir pkg --release) && \
        (cd sketch-solver && {{wasm_pack}} build --target nodejs --out-dir pkg-node --release) && \
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
