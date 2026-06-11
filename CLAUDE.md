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
- Do not use banner comments or ASCII-art dividers (e.g. `====...`, `----...`). Keep any separators minimal. The approved divider is one line `# ─── {text} ───`.
- Comments must describe intent, not restate the code. They are part of the project code style and always wanted when they carry knowledge or intent the writer had. Agent default "no comment" rules do not apply here.
- Try to keep files shorter than 1k lines. This is not a hard limit.
- icons are defined in `icons.py`.
- CAD solver/core is 'blind and deaf'. It only communicates on a stateful websocket channel to the rest of the webapp.

## Feature planning / implementing

When asked to plan a feature:
- Place the plan in `feature/<topic>.md` (this folder has its own git repo and is gitignored from the main project)
- Read the codebase and do deep architectural research before writing
- Write a detailed plan including test specs
- Do NOT execute the plan or touch any other files
- Read existing `feature/*.md` files first to know what is already in development
- Keep an overview and order of exection of features to apply documented in `feature/overview.md`. Keep it very short. One line per feature.

When asked to implement a feature:
- consult `feature/overview.md` to find the next feature to implement in sequence.
- you read the `feature/<topic>.md` and execute according to content.
- Always make tests. Especially on bugs.
- Code review using a subagent.
- when done update `feature/overview.md` to mark as complete and remove the `*.md` file you implemented the feature from.

## knowledge base

There is a knowledge base in `feature/knowledgebase.agent.md` and `feature/knowledgebase.user.md`.
The user file is to be kept original accurate. There are MY statements as the user. They are to be put there by the agent.
In the agent file the whole idea-knowledge-code flow comes together. Keep it detailed, put actual code references, codes and memory to remember in here.