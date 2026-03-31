# .justfile

default:
    just backend
    just frontend

# run all python backend jobs
backend:
    just mypy
    just flake8
    just pytest

mypy:
    mypy tests/ oversolved/

flake8:
    flake8 tests/ oversolved/

pytest:
    pytest tests/


icons:
    python oversolved/icons.py


[working-directory: "frontend"]
frontend:
    just icons
    npm run lint
    npx vitest run
    npm run build

[working-directory: "frontend"]
run_front:
    npm run dev

run_back:
    oversolved --debug