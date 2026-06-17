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
    just flake8
    just pytest

mypy:
    .venv/bin/python -m mypy tests/ oversolved/

flake8:
    .venv/bin/python -m flake8 tests/ oversolved/

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

[working-directory: "frontend"]
frontend-test:
    npx vitest run

[working-directory: "frontend"]
frontend-build:
    npm run build

# Full-document WASM parity gate (TS kernel vs Python baseline). Slow, needs
# OCC.js provisioned, hard-fails on any divergence. Kept out of `just frontend`.
[working-directory: "frontend"]
parity:
    npm run occ:install
    npm run test:parity


runf:
    just run_front

[working-directory: "frontend"]
run_front:
    npm run dev

runb:
    just run_back

static:
    .venv/bin/python -m oversolved.cli staticserve frontend/dist --host 127.0.0.1 --port 5001

run_back:
    oversolved run_server --debug


# Build the Rust solver to WASM (web target for frontend + nodejs target for tests)
wasm:
    cd sketch-solver && wasm-pack build --target web --out-dir pkg --release
    cd sketch-solver && wasm-pack build --target nodejs --out-dir pkg-node --release
    cd frontend && node scripts/copyWasm.mjs

# Lint the Rust solver crate (clippy, deny warnings)
rust-lint:
    cd sketch-solver && cargo clippy -- -D warnings


set shell := ["bash", "-cu"]
run:
    trap 'kill 0' EXIT; \
    just run_front & \
    just run_back & \
    just run_solver & \
    wait