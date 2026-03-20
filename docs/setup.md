# Backend Setup Guide

## What Was Added

A complete Flask-based REST API backend with:

1. **Database Abstraction Layer** (`oversolve/db.py`)
   - Supports both SQLite (for testing) and MariaDB (for production)
   - Migration system for schema versioning
   - Transaction management with context managers
   - Document storage abstraction

2. **Flask Application** (`oversolve/app.py`)
   - REST API endpoints for document CRUD operations
   - Automatic frontend serving from `frontend/dist/`
   - Database initialization and migration runner
   - Error handling and JSON responses

3. **CLI Entry Point** (`oversolve/run_server.py`)
   - Flexible server startup with configurable host/port
   - Support for both SQLite and MariaDB
   - Debug mode and production mode (using Waitress)

4. **Comprehensive Tests**
   - `tests/test_database.py`: 15 tests covering database layer
   - `tests/test_api.py`: 17 tests covering API endpoints
   - All 32 tests pass, covering edge cases and error conditions

5. **Documentation** (`API.md`)
   - Complete API reference
   - Usage examples with curl and Python
   - Database setup instructions
   - Migration guide

## Quick Start

### Development

```bash
# Install dependencies (already done)
pip install flask PyMySQL

# Run with SQLite in debug mode
python -m oversolve.run_server --debug
```

Server will be at `http://localhost:5000`

### Production with SQLite

```bash
python -m oversolve.run_server --db-path /var/lib/oversolve/db.sqlite
```

### Production with MariaDB

```bash
# First, create the database
mysql -u root -p -e "CREATE DATABASE oversolve;"

# Run the server
python -m oversolve.run_server \
  --db-type mariadb \
  --db-host localhost \
  --db-user oversolve \
  --db-password mypassword \
  --db-name oversolve
```

## API Usage

### Store a document

```bash
curl -X PUT http://localhost:5000/api/documents/my_sketch \
  -H "Content-Type: application/json" \
  -d '{"content": "version: 1\nkind: part\n"}'
```

### Retrieve a document

```bash
curl http://localhost:5000/api/documents/my_sketch
```

### List all documents

```bash
curl http://localhost:5000/api/documents
```

### Delete a document

```bash
curl -X DELETE http://localhost:5000/api/documents/my_sketch
```

## Testing

All tests use in-memory SQLite and require no external setup:

```bash
# Run all backend tests
pytest tests/test_database.py tests/test_api.py -v

# Run with coverage
pytest tests/test_database.py tests/test_api.py --cov=oversolve
```

## Database Migrations

To add a new migration:

1. Add a migration function in `oversolve/app.py`:

```python
def migration_002_add_metadata_table(db: Database):
    db.execute("""
        CREATE TABLE metadata (
            doc_id VARCHAR(255),
            key TEXT,
            value TEXT,
            FOREIGN KEY (doc_id) REFERENCES documents(id)
        )
    """)
```

2. Register it in `_register_migrations()`:

```python
db.register_migration(2, 'add_metadata_table', migration_002_add_metadata_table)
```

Migrations run automatically on startup, once per version.

## Architecture

```
oversolve/
├── __init__.py
├── app.py              # Flask app, routes, migrations
├── db.py               # Database abstraction
├── icons.py            # (existing)
├── icon_cairo.py       # (existing)
├── run_server.py       # CLI entry point
└── solver.py           # (existing)

tests/
├── test_api.py         # 17 API endpoint tests
├── test_database.py    # 15 database layer tests
├── test_solver.py      # (existing solver tests)
└── test_serpentine_belt_fixed.py # (existing)

API.md                  # API documentation
SETUP.md                # This file
```

## Environment Variables (Optional)

For production, you can use environment variables instead of CLI args:

```bash
export FLASK_APP=oversolve.app:create_app
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
- User has permissions: `GRANT ALL ON oversolve.* TO 'oversolve'@'localhost';`

**Frontend not serving**

The frontend is only served if `frontend/dist/` exists. Build it first:

```bash
cd frontend
npm run build
```

Then the API server will serve it at `/`.
