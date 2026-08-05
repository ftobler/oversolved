# Setup Guide

## Prerequisites

- Python >= 3.12
- Node.js >= 18
- npm

## System Dependencies

```bash
sudo apt install libcairo2-dev    # pycairo (icon generation)
```

## Backend Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .[dev]
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OVERSOLVED_ADMIN_PASSWORD` | Yes | — | Admin password; server refuses to start without it |
| `OVERSOLVED_SESSION_COOKIE_SECURE` | No | `false` | Set `true` in production for Secure cookies |

## Frontend Setup

```bash
cd frontend
npm install
```

## Running (venv active, project root)

### Backend API

```bash
oversolved run_server --debug                # Flask dev server on :5000
oversolved run_server                         # waitress production on :5000
oversolved run_server --db-type sqlite --db-path /tmp/my.db   # SQLite at custom path
```

### Frontend Dev Server (HMR, separate terminal)

```bash
cd frontend && npm run dev    # Vite on :5173, proxies API to Flask
```

### Just recipes

```bash
just backend    # mypy + ruff + pytest (CI still runs flake8)
just frontend   # lint + test + build
just run_back   # backend dev server
just run_front  # frontend dev server
```

## Database

Two backends are supported: `postgres` (default) and `sqlite`. Migrations run
automatically on startup. For SQLite, pass `--db-type sqlite` (default file
`oversolved.db`, override with `--db-path`).

### PostgreSQL (default)

A dev-only Postgres server is provided via Docker Compose:

```bash
docker compose -f docker-compose-postgres.yml up -d
```

It matches the default DSN (`postgresql://oversolved:oversolved@localhost:5432/oversolved`).
Override with `--db-dsn` or the `OVERSOLVED_DB_DSN` env var:

```bash
oversolved run_server --db-dsn postgresql://user:pass@host:5432/dbname
```

### CLI

```bash
oversolved db status    # current version + pending migrations
oversolved db upgrade   # apply pending
oversolved db check     # exit 1 if pending (CI)
```

These default to `--db-type postgres`; add `--db-type sqlite --db-path ...` for SQLite.

## Testing

```bash
pytest tests/ -v                           # backend (needs Postgres; see below)
cd frontend && npx vitest run               # frontend
mypy oversolved/ tests/ && ruff check oversolved/ tests/   # backend lint (CI still runs flake8)
cd frontend && npm run lint                 # frontend lint
```

Backend tests create an isolated PostgreSQL database per test (dropped
afterward), so a Postgres server must be reachable. Start the dev server with
`docker compose -f docker-compose-postgres.yml up -d`, or point tests at another
server via the `TEST_DB_DSN` env var.

## Troubleshooting

**"Cannot operate on a closed database"** — Ensure all `db.transaction()` usage is within the `with` block.

**"Dependency cairo not found"** — Install `libcairo2-dev`, re-run `pip install`.

**Frontend not serving** — Build it: `cd frontend && npm run build`. For dev, use Vite HMR instead.

**"OVERSOLVED_ADMIN_PASSWORD must be set"** — Set before starting:
```bash
export OVERSOLVED_ADMIN_PASSWORD=my-secret-password
oversolved run_server --debug
```
