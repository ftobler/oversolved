# Backend Setup Guide

## What Was Added

A complete Flask-based REST API backend with:

1. **Database Abstraction Layer** (`oversolved/db.py`)
   - Supports both SQLite (for testing) and MariaDB (for production)
   - Migration system for schema versioning
   - Transaction management with context managers
   - Document storage abstraction

2. **Flask Application** (`oversolved/app.py`)
   - REST API endpoints for document CRUD operations
   - Automatic frontend serving from `frontend/dist/`
   - Database initialization and migration runner
   - Error handling and JSON responses

3. **CLI Entry Point** (`oversolved/run_server.py`/`main.py`)
   - Flexible server startup with configurable host/port
   - Support for both SQLite and MariaDB
   - Debug mode and production mode (using Waitress)
   - Registered command `ovsersolved`

5. **Documentation** (`api.md`)
   - Complete API reference
   - Usage examples with curl and Python
   - Database setup instructions
   - Migration guide

## Quick Start

### Development

```bash
# Install dependencies for dev
pip install -e .[dev]

# Run with SQLite in debug mode
python oversolved --debug
```

Server will be at `http://localhost:5000`

### Production with SQLite

```bash
python oversolved --db-path /var/lib/oversolved/db.sqlite
```

### Production with MariaDB

```bash
# First, create the database
mysql -u root -p -e "CREATE DATABASE oversolved;"

# Run the server
python -m oversolved.run_server \
  --db-type mariadb \
  --db-host localhost \
  --db-user oversolved \
  --db-password mypassword \
  --db-name oversolved
```

## Testing

### Backend Tests

```bash
pytest tests/test_database.py tests/test_api.py -v
```

Uses in-memory SQLite, no external setup required.

### Frontend Tests

```bash
cd frontend
npx vitest run
```

Runs all Vitest test suites in the frontend directory.

## Environment Variables (Optional)

For production, you can use environment variables instead of CLI args:

```bash
export FLASK_APP=oversolved.app:create_app
export FLASK_ENV=production

# Then adjust your run_server.py to read from env if needed
```

## Performance Notes

- **SQLite**: Suitable for development and testing. Single-file database.
- **MariaDB**: Recommended for production. Supports concurrent writes.

For the constraint solver use case, the API is I/O bound (document storage), not CPU bound. Both databases will perform well.

## Troubleshooting

**"Cannot operate on a closed database" error**

This happens if a transaction is used after the connection is closed. Check that:
- You're using the `with db.transaction():` context manager
- In production mode, only the TESTING config setting affects database closing

**MariaDB connection errors**

Verify:
- MariaDB/MySQL is running: `mysql -u root -p`
- Database exists: `SHOW DATABASES;`
- User has permissions: `GRANT ALL ON oversolved.* TO 'oversolved'@'localhost';`

**Frontend not serving**

The frontend is only served if `frontend/dist/` exists. Build it first:

```bash
cd frontend
npm run build
```

Then the API server will serve it at `/`.
