# Project: Oversolved

A mechanical CAD system running in the browser.
Python/Flask backend with a React frontend.

## Structure
- `oversolved/` - Flask application source
- `tests/` - pytest test suite
- `frontend/` - React frontend (must `cd frontend` before running frontend commands)

## Backend Commands
from the .justfile: `just backend`

```bash
pytest tests/
mypy oversolved/ tests/
flake8 oversolved/ tests/
```

## Frontend Commands
from the .justfile: `just frontend`

```bash
cd frontend
npm run build
npm run lint
npx vitest run
```

## Conventions
- Test driven development. Frontend changes must pass `just frontend`.
- Test driven development. Backend changes must pass `just backend`.
- Flask and CAD solver backend lives in `oversolved/`.
- mypy and flake8 runs on both `oversolved/` and `tests/`
- code style: do not use em or en-dashes.
- Agents must not commit to git.
- Use two spaces before inline comments. Example: `be_nice = True  # sometimes`
- Do not use banner comments or ASCII-art dividers (e.g. `====`, `----`). Keep any separators minimal.
- Comments must describe intent, not restate the code.

## important files
- oversolved/solver.py