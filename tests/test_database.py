"""Tests for database layer."""

import pytest
from oversolve.db import Database, SQLiteConnection, DocumentStore


@pytest.fixture
def db():
    """Create an in-memory SQLite database for testing."""
    conn = SQLiteConnection(':memory:')
    database = Database(conn)

    # Register migrations
    def migration_001_create_documents_table(db: Database):
        """Create the documents table."""
        db.execute("""
            CREATE TABLE documents (
                id VARCHAR(255) PRIMARY KEY,
                content TEXT NOT NULL
            )
        """)

    database.register_migration(1, 'create_documents_table', migration_001_create_documents_table)
    database.init()
    yield database
    database.close()


@pytest.fixture
def doc_store(db):
    """Create a document store."""
    return DocumentStore(db)


class TestSQLiteConnection:
    """Tests for SQLite connection."""

    def test_execute_query(self):
        """Test basic query execution."""
        conn = SQLiteConnection(':memory:')
        cursor = conn.execute("SELECT 1 as num")
        row = cursor.fetchone()
        assert row[0] == 1
        conn.close()

    def test_commit_rollback(self):
        """Test commit and rollback."""
        conn = SQLiteConnection(':memory:')
        conn.execute("CREATE TABLE test (id INTEGER)")
        conn.commit()

        conn.execute("INSERT INTO test VALUES (1)")
        conn.commit()

        cursor = conn.execute("SELECT * FROM test")
        assert cursor.fetchone()[0] == 1

        conn.execute("DELETE FROM test")
        conn.rollback()

        cursor = conn.execute("SELECT * FROM test")
        assert cursor.fetchone()[0] == 1

        conn.close()


class TestDatabase:
    """Tests for Database class."""

    def test_init_creates_schema_version_table(self, db):
        """Test that init creates schema_version table."""
        cursor = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
        assert cursor.fetchone() is not None

    def test_migration_runs_once(self, db):
        """Test that migrations run only once."""
        call_count = 0

        def test_migration(database: Database):
            nonlocal call_count
            call_count += 1
            database.execute("CREATE TABLE test (id INTEGER)")

        db.register_migration(10, 'test_migration', test_migration)
        db.init()

        assert call_count == 1

        # Re-init should not run migration again
        db.init()
        assert call_count == 1

    def test_transaction_commits(self, db):
        """Test transaction commits on success."""
        db.execute("CREATE TABLE test (id INTEGER)")
        db.commit()

        with db.transaction():
            db.execute("INSERT INTO test VALUES (1)")

        cursor = db.execute("SELECT * FROM test")
        assert cursor.fetchone()[0] == 1

    def test_transaction_rollback_on_error(self, db):
        """Test transaction rolls back on error."""
        db.execute("CREATE TABLE test (id INTEGER)")
        db.commit()

        try:
            with db.transaction():
                db.execute("INSERT INTO test VALUES (1)")
                raise RuntimeError("Test error")
        except RuntimeError:
            pass

        cursor = db.execute("SELECT COUNT(*) FROM test")
        assert cursor.fetchone()[0] == 0


class TestDocumentStore:
    """Tests for DocumentStore."""

    def test_store_and_retrieve(self, doc_store):
        """Test storing and retrieving a document."""
        doc_id = 'doc1'
        content = 'version: 1\nkind: part\n'

        doc_store.store(doc_id, content)
        retrieved = doc_store.retrieve(doc_id)

        assert retrieved == content

    def test_retrieve_nonexistent(self, doc_store):
        """Test retrieving a nonexistent document."""
        retrieved = doc_store.retrieve('nonexistent')
        assert retrieved is None

    def test_update_document(self, doc_store):
        """Test updating an existing document."""
        doc_id = 'doc1'
        content1 = 'version: 1\n'
        content2 = 'version: 2\n'

        doc_store.store(doc_id, content1)
        doc_store.store(doc_id, content2)

        retrieved = doc_store.retrieve(doc_id)
        assert retrieved == content2

    def test_delete_document(self, doc_store):
        """Test deleting a document."""
        doc_id = 'doc1'
        doc_store.store(doc_id, 'content')

        deleted = doc_store.delete(doc_id)
        assert deleted is True

        retrieved = doc_store.retrieve(doc_id)
        assert retrieved is None

    def test_delete_nonexistent(self, doc_store):
        """Test deleting a nonexistent document."""
        deleted = doc_store.delete('nonexistent')
        assert deleted is False

    def test_list_ids(self, doc_store):
        """Test listing document IDs."""
        ids = ['doc1', 'doc2', 'doc3']
        for doc_id in ids:
            doc_store.store(doc_id, f'content of {doc_id}')

        retrieved_ids = doc_store.list_ids()
        assert retrieved_ids == sorted(ids)

    def test_list_ids_empty(self, doc_store):
        """Test listing IDs when no documents exist."""
        ids = doc_store.list_ids()
        assert ids == []

    def test_store_large_yaml(self, doc_store):
        """Test storing a large YAML document."""
        doc_id = 'large_doc'
        # Create a large YAML-like content
        content = 'version: 1\n' + 'key: value\n' * 10000

        doc_store.store(doc_id, content)
        retrieved = doc_store.retrieve(doc_id)

        assert retrieved == content
        assert len(retrieved) > 50000

    def test_store_special_characters(self, doc_store):
        """Test storing documents with special characters."""
        doc_id = 'special_doc'
        content = '''
version: 1
kind: part
features:
  - id: sketch_1
    label: "Test with 'quotes' and \"double\" quotes"
    initial:
      point_a: [1.5, 2.3]
      line: [0.0, 0.0, 10.5, 20.3]
'''

        doc_store.store(doc_id, content)
        retrieved = doc_store.retrieve(doc_id)

        assert retrieved == content
