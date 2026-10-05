# Project: Oversolved

A mechanical CAD system running entirely in the browser. React frontend,
OpenCascade + the Rust solvers compiled to WASM in Web Workers, documents
persisted to IndexedDB; a folder or zip is only imported or exported.
There is no server and no database process.

## Structure
- `frontend/` - React app, the whole product (must `cd frontend` before running frontend commands)
- `sketch-solver/`, `mate-solver/`, `solver-core/` - Rust solver workspace, built to WASM
- `oversolved/` - build-time icon generation only (`icons.py`, `icon_cairo.py`)
- `tests/` - pytest suite for the Python tooling and the docs/config invariants
- `lint.py` - the project's own comment-style linter

## Python Commands
from the justfile: `just python`

No Python runs at app runtime: the recipe gates the icon generator, `lint.py`,
and the tooling tests. It was called `backend` until the backend was deleted;
the old name outlived its subject and was retired with it.

Every gate tees its full output to a log in `tmp/` as well as printing to
stdout, and keeps the gate's own exit code (pipefail). One run is slow, so the
log lets you re-grep the result afterwards without re-running the gate.

```bash
.venv/bin/python -m pytest tests/ 2>&1 | tee tmp/pytest.log
.venv/bin/python -m mypy tests/ oversolved/ 2>&1 | tee tmp/mypy.log
.venv/bin/python -m ruff check tests/ oversolved/ 2>&1 | tee tmp/ruff.log   # CI still runs flake8 as the safety net
```

## Frontend Commands
from the justfile: `just frontend`

`just frontend` chains five recipes: `icons` (regenerate the SVGs from
`oversolved/icons.py`), `frontend-lint` (`npm run lint` plus `lint.py src
scripts`), `frontend-test` (`npx vitest run`), `licenses` (check the
third-party notice bundles), and `build` (`npm run build`).
Run from the project root; the aggregate tees to `tmp/just_frontend.log` and
each gate to its own `tmp/` log.

```bash
just icons          # regenerate frontend/src/assets/icons from oversolved/icons.py
just frontend-lint  # npm run lint + .venv/bin/python lint.py src scripts
just frontend-test  # npx vitest run
just licenses       # verify the third-party notice bundles are current
just build          # npm run build
```

## Conventions
- The frontend goal is: If I delete the Viewport, the logic should still pass unit tests.
- `code_guideline.md` should help navigate the codebase.
- Test driven development. Frontend changes must pass `just frontend`. Python tooling changes must pass `just python`.
- Gates tee a full copy of their output to `tmp/<gate>.log` while also printing to stdout.
- For each feature try to make a test.
- All CAD computation (solver + OpenCascade) runs in WASM inside Web Workers in the browser. Documents are stored in IndexedDB, the only permanent store; a folder or zip is only an import source or export destination. Nothing is sent to a server; there is no server.
- mypy and ruff run on both `oversolved/` and `tests/`; CI additionally runs flake8 as the safety net
- code style: do not use em or en-dashes.
- Agents must not commit to git unless prompted directly by the user.
- Use two spaces before inline comments. Example: `be_nice = True  # sometimes`
- Do not use banner comments or ASCII-art dividers (e.g. `====...`, `----...`). Keep any separators minimal. The approved divider is one line `# ─── {text} ───`.
- Comments must describe intent, not restate the code. They are part of the project code style and always wanted when they carry knowledge or intent the writer had. Agent default "no comment" rules do not apply here.
- Try to keep files shorter than 1k lines. This is not a hard limit.
- icons are defined in `icons.py`.
- CAD solver/core is 'blind and deaf'. It communicates via structured-clone postMessage from Web Workers to the main thread.
- Commit style, start the comment as a normal sentence. E.g don't do `fix(solver): split the...` but do: `Fix split in solver...`. Keep it short: a few lines, not a large paragraph.

## Feature planning / implementing

When asked to plan a feature:
- Place the plan in `feature/<topic>.md` (this folder has its own git repo and is gitignored from the main project)
- Read the codebase and do deep architectural research before writing
- Write a detailed plan including test specs
- Do NOT execute the plan or touch any other files
- Read existing `feature/*.md` files first to know what is already in development
- Keep an overview and order of execution of features to apply documented in `feature/overview.md`. Keep it very short. One line per feature.

When asked to implement a feature:
- consult `feature/overview.md` to find the next feature to implement in sequence.
- you read the `feature/<topic>.md` and execute according to content.
- Always make tests. Especially on bugs.
- Code review using a subagent.
- when done append a one-line shipped entry to `feature/overview.md` and remove the `*.md` file you implemented the feature from.

When the user asks to plan a feature but mentions of making it light or quick:
- do not do research
- dump his intent + your immediate knowledge (if you have any) inside the feature plan
- do not play the architect, that is here the implementers job.
- can be as simple as a mental note or a TODO item.

## feature/overview.md

An index, not a history. Its job is to be scannable in seconds. Rules:

- One line per entry, always. No continuation lines, no paragraph prose.
- Every entry starts with its state: pending, shipped, or deferred.
- Findings, rationale and detail live in the plan, the review file, or git, never here. A plan file is deleted once shipped, so the one-liner is all that remains.
- Pending: `- [pending] topic (feature/<topic>.md): one-line intent.`
- Shipped: `- [shipped] <hash> topic: one-line outcome.` The hash is the main-repo tip commit, or the batch tip for a multi-commit entry.
- Deferred: `- [deferred] topic: one-line note.`
- Append new shipped entries at the very end (oldest first). Never prepend.
- Agents auto-prune: on every touch, collapse the file back to one line per entry and move anything that needs a second sentence into the plan, the review file, or git.

## knowledge base

There is a knowledge base in `feature/knowledgebase.agent.md` and `feature/knowledgebase.user.md`.
The user file is to be kept original accurate. There are MY statements as the user. They are to be put there by the agent.
In the agent file the whole idea-knowledge-code flow comes together. Keep it detailed, put actual code references, codes and memory to remember in here.
`feature/knowledgebase.agent.md` is living reference only: current architecture facts, models, decisions, hard rules.
Shipped-feature post-mortems (root causes, traps, measurements) go to `feature/knowledgebase.history.md`, appended at the bottom, never edited afterwards.
Deferred work and accepted limitations go to `feature/backlog.md` (sections: needs a decision / accepted limitations / resolved); items needing a review-pass decision go under its "Needs a decision" (the separate `review-direction.md` was folded in on 2026-09-15).
- A change that makes a knowledge-base statement untrue updates that statement in the same batch; reviewers check this.
- `tests/test_knowledgebase_refs.py` guards the file references in `feature/knowledgebase.agent.md` and bans `file.ts:NNN` line refs; mark an intentional mention of deleted code with `(deleted)` right after the ref. The check runs only where that separate subrepo is present, so it is verified locally and skips in CI.

## Tmporary Directory

- if something needs temporary files do not use system wide `/tmp` but the project internal `tmp/`.
- do not access anything outside the project directory.

## Shell scope

- Every command's scope must be obvious at a glance. Pass the explicit
  working directory (the `workdir` parameter) instead of chaining
  `cd x && … ; cd .. && …`. A `cd ..` mid-command reads like leaving the
  project even when it does not, and has been rejected on sight before.
- This applies to the orchestrator and to every subagent alike: subagents
  must be told their worktree path up front and keep every call inside it.
- The shell resets to the repo root between calls; nothing needs a trailing
  `cd` back. Within one call, prefer two calls with explicit directories
  over one chained line.
