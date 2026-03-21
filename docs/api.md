# Oversolve API

Flask-based REST API for storing and retrieving YAML constraint solver documents.

## Features

- **Document Storage**: Store and retrieve YAML constraint solver specifications
- **Database Abstraction**: Supports SQLite (for testing) and MariaDB (for production)
- **Migrations**: Manual version-based migration system for schema management
- **Frontend Serving**: Automatically serves the built React frontend from `/`
- **REST API**: Simple JSON-based REST API for document operations

## Installation

```bash
pip install -e ".[dev]"
```

## Running the Server

### Development Mode (SQLite, Flask debug server)

```bash
python -m oversolved.run_server --debug
```

### Production Mode (SQLite, Waitress)

```bash
python -m oversolved.run_server --db-type sqlite --db-path oversolved.db
```

### With MariaDB

```bash
python -m oversolved.run_server \
  --db-type mariadb \
  --db-host localhost \
  --db-user root \
  --db-password mypassword \
  --db-name oversolved
```

## API Endpoints

### Store Document

**PUT** `/api/documents/{doc_id}`
**POST** `/api/documents/{doc_id}`

Store or update a YAML document.

**Request:**
```json
{
  "content": "version: 1\nkind: part\n..."
}
```

**Response:**
```json
{
  "id": "doc_id",
  "status": "stored"
}
```

**Status Code:** 201

---

### Retrieve Document

**GET** `/api/documents/{doc_id}`

Retrieve a YAML document by ID.

**Response:**
```json
{
  "id": "doc_id",
  "content": "version: 1\nkind: part\n..."
}
```

**Status Code:** 200 (found) or 404 (not found)

---

### Delete Document

**DELETE** `/api/documents/{doc_id}`

Delete a document by ID.

**Response:**
```json
{
  "id": "doc_id",
  "status": "deleted"
}
```

**Status Code:** 200 (deleted) or 404 (not found)

---

### List Documents

**GET** `/api/documents`

List all document IDs.

**Response:**
```json
{
  "documents": ["doc1", "doc2", "doc3"]
}
```

**Status Code:** 200

---

### Serve Frontend

**GET** `/`
**GET** `/<path>`

Serves the built React frontend if available in `frontend/dist/`.

---

## Database

### SQLite (Testing)

Default for development. Use in-memory database or file-based:

```bash
python -m oversolved.run_server --db-path :memory:
python -m oversolved.run_server --db-path mydb.sqlite
```

### MariaDB (Production)

Requires database to be created beforehand:

```sql
CREATE DATABASE oversolved;
```

Then run the server with MariaDB configuration. Migrations will create tables automatically.

## Migrations

Database schema is managed through migrations. Each migration is a Python function registered with the database:

```python
def migration_001_create_documents_table(db: Database):
    db.execute("""
        CREATE TABLE documents (
            id VARCHAR(255) PRIMARY KEY,
            content LONGTEXT NOT NULL
        )
    """)

db.register_migration(1, 'create_documents_table', migration_001_create_documents_table)
```

Migrations run automatically on startup in version order. Each migration runs only once.

To add a new migration:

1. Add a function in `oversolved/app.py` under `_register_migrations()`
2. Increment the version number
3. Register it with `db.register_migration()`

The `schema_version` table tracks which migrations have run.

## Testing

```bash
pytest tests/test_database.py tests/test_api.py -v
```

Tests use an in-memory SQLite database and don't require external setup.

## Example Usage

### Using curl

```bash
# Store a document
curl -X PUT http://localhost:5000/api/documents/my_sketch \
  -H "Content-Type: application/json" \
  -d '{
    "content": "version: 1\nkind: part\nfeatures:\n  - id: sketch_1\n"
  }'

# Retrieve a document
curl http://localhost:5000/api/documents/my_sketch

# List all documents
curl http://localhost:5000/api/documents

# Delete a document
curl -X DELETE http://localhost:5000/api/documents/my_sketch
```

### Using Python

```python
import requests
import json

# Store
response = requests.put(
    'http://localhost:5000/api/documents/my_sketch',
    json={'content': 'version: 1\nkind: part\n'}
)
print(response.json())  # {'id': 'my_sketch', 'status': 'stored'}

# Retrieve
response = requests.get('http://localhost:5000/api/documents/my_sketch')
print(response.json()['content'])

# List
response = requests.get('http://localhost:5000/api/documents')
print(response.json()['documents'])

# Delete
requests.delete('http://localhost:5000/api/documents/my_sketch')
```

## Architecture

```
oversolved/
├── db.py              # Database abstraction layer
├── app.py             # Flask application and routes
└── run_server.py      # CLI entry point

tests/
├── test_database.py   # Database layer tests
└── test_api.py        # API endpoint tests
```

### Key Classes

- `DatabaseConnection`: Abstract interface for database connections
- `SQLiteConnection`: SQLite implementation
- `MariaDBConnection`: MariaDB/PyMySQL implementation
- `Database`: Migration manager and transaction handler
- `DocumentStore`: High-level API for document operations
