# .justfile

# `just` command runner. Targets can be run with `just <target>`.

export OVERSOLVED_ADMIN_PASSWORD := "admin"
export OVERSOLVED_SESSION_COOKIE_SECURE := "false"

default:
    just backend
    just frontend

# run all python backend jobs
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


runf:
    just run_front

[working-directory: "frontend"]
run_front:
    npm run dev

runb:
    just run_back

run_back:
    oversolved run_server --debug

runs:
    just run_solver

run_solver:
    oversolved-solver