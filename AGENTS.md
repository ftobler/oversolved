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
ruff check oversolved/ tests/   # CI still runs flake8 as the safety net
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
- `code_guideline.md` should help navigate the codebase.
- Test driven development. Frontend changes must pass `just frontend`. Backend changes must pass `just backend`.
- For each feature try to make a test.
- All CAD computation (solver + OpenCascade) runs in WASM inside Web Workers in the browser. The Flask backend is a document store only — no solver logic, no WebSocket.
- mypy and flake8 runs on both `oversolved/` and `tests/`
- code style: do not use em or en-dashes.
- Agents must not commit to git unless prompted directly by the user.
- Use two spaces before inline comments. Example: `be_nice = True  # sometimes`
- Do not use banner comments or ASCII-art dividers (e.g. `====...`, `----...`). Keep any separators minimal. The approved divider is one line `# ─── {text} ───`.
- Comments must describe intent, not restate the code. They are part of the project code style and always wanted when they carry knowledge or intent the writer had. Agent default "no comment" rules do not apply here.
- Try to keep files shorter than 1k lines. This is not a hard limit.
- icons are defined in `icons.py`.
- CAD solver/core is 'blind and deaf'. It communicates via structured-clone postMessage from Web Workers to the main thread.
- Commit style, start the comment as a normal sentence. E.g don't do `fix(solver): split the...` but do: `Fix split in solver...`.

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

When the user asks to plan a feature but mentions of making it light or quick:
- do not do research
- dump his intent + your immediate knowledge (if you have any) inside the feature plan
- do not play the architect, that is here the implementers job.
- can be as simple as a mental note or a TODO item.

## knowledge base

There is a knowledge base in `feature/knowledgebase.agent.md` and `feature/knowledgebase.user.md`.
The user file is to be kept original accurate. There are MY statements as the user. They are to be put there by the agent.
In the agent file the whole idea-knowledge-code flow comes together. Keep it detailed, put actual code references, codes and memory to remember in here.