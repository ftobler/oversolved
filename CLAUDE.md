# Project: Oversolved

Python/Flask backend with a React frontend.

## Structure
- `oversolved/` - Flask application source
- `tests/` - pytest test suite
- `frontend/` - React frontend (must `cd frontend` before running frontend commands)

## Backend Commands
```bash
pytest tests/
mypy oversolved/ tests/
flake8 oversolved/ tests/
```

## Frontend Commands
```bash
cd frontend
npm run build
npm run lint
npx vitest run
```

## Conventions
- Test driven development.
- Flask and CAD solver backend lives in `oversolved/`.
- mypy and flake8 runs on both `oversolved/` and `tests/`
- Frontend changes require `npm run build` + `npm run lint` to pass
- code style: do not use em or en-dashes.
- Agents must never commit to Git.

## important files
- tests/test_sovler.py
- oversolved/solver.py