# .justfile

# `just` command runner. Targets can be run with `just <target>`.

export OVERSOLVED_ADMIN_PASSWORD := "aadmin"
export OVERSOLVED_SESSION_COOKIE_SECURE := "false"
export TESTING := "true"
export OVERSOLVED_DB_DSN := "postgresql://oversolved:oversolved@localhost:5432/oversolved"

default:
    just backend
    just frontend

# run all python backend jobs
# requires postgres: docker compose -f docker-compose-postgres.yml up -d
# override DB with: TEST_DB_DSN=postgresql://... just backend
backend:
    just mypy
    just ruff
    just pytest

mypy:
    .venv/bin/python -m mypy tests/ oversolved/

# local ruff gate; CI still runs flake8 (same E/F/W rule set) as the safety net
ruff:
    .venv/bin/python -m ruff check tests/ oversolved/

pytest:
    .venv/bin/python -m pytest tests/


icons:
    .venv/bin/python oversolved/icons.py


[working-directory: "frontend"]
frontend-install:
    npm install

[working-directory: "frontend"]
frontend:
    just icons
    just frontend-lint
    just frontend-test
    just frontend-build

[working-directory: "frontend"]
frontend-lint:
    npm run lint
    ../.venv/bin/python ../lint.py src

[working-directory: "frontend"]
frontend-test:
    npx vitest run

[working-directory: "frontend"]
frontend-build:
    npm run build

[working-directory: "frontend"]
install-npm:
    npm install

# Full-document WASM parity gate (TS kernel vs frozen baseline). Slow, needs
# OCC.js provisioned, hard-fails on any divergence. Kept out of `just frontend`.
[working-directory: "frontend"]
parity:
    just install-occ
    npm run test:parity


runf:
    just run_front

[working-directory: "frontend"]
run_front:
    npm run dev

# Install all dependencies (Python + frontend + wasm tools + opencascade.js)
install:
    test -d .venv || python3 -m venv .venv
    # note cairo needs apt libcairo2-dev
    .venv/bin/pip install -e ".[dev]"
    just install-npm
    just install-wasm
    just install-occ

[working-directory: "frontend"]
install-occ:
    npm run occ:install
    npm run occ:provision

runb:
    just run_back

# Build the zero-backend deploy: the SAME app bundle as `just frontend-build`,
# then stamps dist/runtime-config.js with backend=static (no auth wall,
# IndexedDB persistence, local-WASM STEP/STL export). The flag is read at boot,
# so the JS bundle is byte-identical to the http build -- only that one config
# file differs. Like `frontend-build`, this assumes public/occ + public/wasm are
# already provisioned by `just install` (occ:provision needs the --no-save
# opencascade.js dep, so it belongs to install, not every build).
[working-directory: "frontend"]
build:
    npm run build:static

# Serve frontend/dist on a plain static server (npx serve, SPA fallback).
# you need to build first.
static:
    npx --yes serve -s frontend/dist

run_back:
    source .venv/bin/activate && oversolved run_server --debug


install-wasm:
    cargo install wasm-pack

# Build both Rust solvers to WASM (web target for frontend + nodejs target for
# tests). Two crates, two binaries: the sketch/OCC worker and the anchor solver
# worker each load only their own. See the workspace root Cargo.toml.
wasm:
    cd sketch-solver && wasm-pack build --target web --out-dir pkg --release
    cd sketch-solver && wasm-pack build --target nodejs --out-dir pkg-node --release
    cd mate-solver && wasm-pack build --target web --out-dir pkg --release
    cd mate-solver && wasm-pack build --target nodejs --out-dir pkg-node --release
    cd frontend && node scripts/copyWasm.mjs

# Test the Rust solver workspace (solver-core + sketch-solver + mate-solver)
rust-test:
    cargo test --workspace

# Lint the Rust solver workspace (clippy, deny warnings)
rust-lint:
    cargo clippy --workspace -- -D warnings

# Remove build artifacts (keeps .venv and node_modules)
clean:
    find . -type d \( -name __pycache__ -o -name .pytest_cache -o -name .mypy_cache -o -name .ruff_cache \) -exec rm -rf {} + 2>/dev/null; true
    find . -name '*.pyc' -delete
    rm -rf *.egg-info dist build
    rm -rf sketch-solver/pkg sketch-solver/pkg-node
    rm -rf mate-solver/pkg mate-solver/pkg-node
    rm -rf frontend/dist frontend/public/wasm

# Remove everything above plus venv and node_modules
deepclean:
    just clean
    rm -rf .venv
    rm -rf frontend/node_modules


set shell := ["bash", "-cu"]
run:
    trap 'kill 0' EXIT; \
    just run_front & \
    just run_back & \
    just run_solver & \
    wait