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
oversolved run_server --db-path /tmp/my.db    # custom SQLite path
```

### Frontend Dev Server (HMR, separate terminal)

```bash
cd frontend && npm run dev    # Vite on :5173, proxies API to Flask
```

### Just recipes

```bash
just backend    # mypy + flake8 + pytest
just frontend   # lint + test + build
just run_back   # backend dev server
just run_front  # frontend dev server
```

## Database

SQLite is the default (`oversolved.db`). Migrations run automatically on first request.

### MariaDB (Production)

```bash
mysql -u root -p -e "CREATE DATABASE oversolved;"
mysql -u root -p -e "GRANT ALL ON oversolved.* TO 'oversolved'@'localhost';"
oversolved run_server --db-type mariadb --db-host localhost --db-user oversolved --db-password mypassword --db-name oversolved
```

### CLI

```bash
oversolved db --db-type sqlite status    # current version + pending migrations
oversolved db --db-type sqlite upgrade   # apply pending
oversolved db --db-type sqlite check     # exit 1 if pending (CI)
```

All `--db-*` flags work with these subcommands.

## Testing

```bash
pytest tests/ -v                           # backend (in-memory SQLite, no setup)
cd frontend && npx vitest run               # frontend
mypy oversolved/ tests/ && flake8 oversolved/ tests/   # backend lint
cd frontend && npm run lint                 # frontend lint
```

## Troubleshooting

**"Cannot operate on a closed database"** — Ensure all `db.transaction()` usage is within the `with` block.

**"Dependency cairo not found"** — Install `libcairo2-dev`, re-run `pip install`.

**Frontend not serving** — Build it: `cd frontend && npm run build`. For dev, use Vite HMR instead.

**"OVERSOLVED_ADMIN_PASSWORD must be set"** — Set before starting:
```bash
export OVERSOLVED_ADMIN_PASSWORD=my-secret-password
oversolved run_server --debug
```
