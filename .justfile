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


[working-directory: "frontend"]
frontend:
    npm run lint
    npx vitest run
    npm run build


