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
- The frontend goal is: If I delete the Viewport, the logic should still pass unit tests.
- `code_guidelines.md` should help navigate the codebase.
- Test driven development. Frontend changes must pass `just frontend`. Backend changes must pass `just backend`.
- For each feature try to make a test.
- Flask and CAD solver backend lives in `oversolved/`.
- mypy and flake8 runs on both `oversolved/` and `tests/`
- code style: do not use em or en-dashes.
- Agents must not commit to git.
- Use two spaces before inline comments. Example: `be_nice = True  # sometimes`
- Do not use banner comments or ASCII-art dividers (e.g. `====`, `----`). Keep any separators minimal.
- Comments must describe intent, not restate the code.
- try to keep files shorter than 1k lines.
- icons are defined in `icons.py`.

## Feature planning / implementing

When asked to plan a feature:
- Place the plan in `feature/<topic>.md` (this folder has its own git repo and is gitignored from the main project)
- Read the codebase and do deep architectural research before writing
- Write a detailed plan including test specs
- Do NOT execute the plan or touch any other files
- Read existing `feature/*.md` files first to know what is already in development
- Keep an overview and order of exection of features to apply documented in `feature/overview.md`. Keep it very short. One line per feature.

When asked to implement a feature:
- you read the `feature/<topic>.md` and execute according to content.
- Always make tests. Especially on bugs.
- Code review using a subagent.


## important files
- oversolved/solver.py
