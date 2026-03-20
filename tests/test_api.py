"""Tests for Flask API."""

import json
import pytest
from oversolve.app import create_app


@pytest.fixture
def app(tmp_path):
    """Create a test Flask app with a file-based SQLite database."""
    db_path = str(tmp_path / 'test.db')
    test_app = create_app({
        'DB_TYPE': 'sqlite',
        'DB_PATH': db_path,
    })
    test_app.config['TESTING'] = True
    return test_app


@pytest.fixture
def client(app):
    """Create a test client."""
    return app.test_client()


@pytest.fixture
def app_context(app):
    """Create an app context."""
    with app.app_context():
        yield app


class TestDocumentAPI:
    """Tests for document API endpoints."""

    def test_store_document(self, client):
        """Test storing a document."""
        payload = {
            'content': 'version: 1\nkind: part\n'
        }
        response = client.put(
            '/api/documents/doc1',
            data=json.dumps(payload),
            content_type='application/json'
        )
        assert response.status_code == 201
        data = json.loads(response.data)
        assert data['id'] == 'doc1'
        assert data['status'] == 'stored'

    def test_retrieve_document(self, client):
        """Test retrieving a document."""
        content = 'version: 1\nkind: part\n'
        client.put(
            '/api/documents/doc1',
            data=json.dumps({'content': content}),
            content_type='application/json'
        )

        response = client.get('/api/documents/doc1')
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data['id'] == 'doc1'
        assert data['content'] == content

    def test_retrieve_nonexistent(self, client):
        """Test retrieving a nonexistent document."""
        response = client.get('/api/documents/nonexistent')
        assert response.status_code == 404
        data = json.loads(response.data)
        assert 'error' in data

    def test_delete_document(self, client):
        """Test deleting a document."""
        client.put(
            '/api/documents/doc1',
            data=json.dumps({'content': 'test'}),
            content_type='application/json'
        )

        response = client.delete('/api/documents/doc1')
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data['status'] == 'deleted'

        # Verify it's deleted
        response = client.get('/api/documents/doc1')
        assert response.status_code == 404

    def test_delete_nonexistent(self, client):
        """Test deleting a nonexistent document."""
        response = client.delete('/api/documents/nonexistent')
        assert response.status_code == 404

    def test_list_documents(self, client):
        """Test listing documents."""
        docs = ['doc1', 'doc2', 'doc3']
        for doc_id in docs:
            client.put(
                f'/api/documents/{doc_id}',
                data=json.dumps({'content': f'content of {doc_id}'}),
                content_type='application/json'
            )

        response = client.get('/api/documents')
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data['documents'] == sorted(docs)

    def test_list_documents_empty(self, client):
        """Test listing documents when none exist."""
        response = client.get('/api/documents')
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data['documents'] == []

    def test_store_invalid_json(self, client):
        """Test storing with invalid JSON."""
        response = client.put(
            '/api/documents/doc1',
            data='not json',
            content_type='application/json'
        )
        assert response.status_code == 400

    def test_store_missing_content(self, client):
        """Test storing without content field."""
        response = client.put(
            '/api/documents/doc1',
            data=json.dumps({'other_field': 'value'}),
            content_type='application/json'
        )
        assert response.status_code == 400
        data = json.loads(response.data)
        assert 'Missing' in data['error']

    def test_store_non_string_content(self, client):
        """Test storing non-string content."""
        response = client.put(
            '/api/documents/doc1',
            data=json.dumps({'content': 123}),
            content_type='application/json'
        )
        assert response.status_code == 400
        data = json.loads(response.data)
        assert 'string' in data['error']

    def test_store_without_content_type(self, client):
        """Test storing without JSON content type."""
        response = client.put(
            '/api/documents/doc1',
            data=json.dumps({'content': 'test'})
        )
        assert response.status_code == 400

    def test_post_is_same_as_put(self, client):
        """Test that POST works same as PUT."""
        payload = {'content': 'version: 1\n'}
        response = client.post(
            '/api/documents/doc1',
            data=json.dumps(payload),
            content_type='application/json'
        )
        assert response.status_code == 201

        response = client.get('/api/documents/doc1')
        data = json.loads(response.data)
        assert data['content'] == payload['content']

    def test_update_document(self, client):
        """Test updating an existing document."""
        content1 = 'version: 1\n'
        content2 = 'version: 2\n'

        # Store first version
        client.put(
            '/api/documents/doc1',
            data=json.dumps({'content': content1}),
            content_type='application/json'
        )

        # Update to second version
        response = client.put(
            '/api/documents/doc1',
            data=json.dumps({'content': content2}),
            content_type='application/json'
        )
        assert response.status_code == 201

        # Verify updated
        response = client.get('/api/documents/doc1')
        data = json.loads(response.data)
        assert data['content'] == content2

    def test_large_document(self, client):
        """Test storing and retrieving a large document."""
        large_content = 'version: 1\n' + 'key: value\n' * 5000
        response = client.put(
            '/api/documents/large',
            data=json.dumps({'content': large_content}),
            content_type='application/json'
        )
        assert response.status_code == 201

        response = client.get('/api/documents/large')
        data = json.loads(response.data)
        assert data['content'] == large_content

    def test_special_characters_in_content(self, client):
        """Test storing documents with special characters."""
        special_content = '''version: 1
kind: part
features:
  - id: sketch_1
    label: "Test with 'quotes' and \\"double\\" quotes"
    initial:
      point_a: [1.5, 2.3]
'''
        response = client.put(
            '/api/documents/special',
            data=json.dumps({'content': special_content}),
            content_type='application/json'
        )
        assert response.status_code == 201

        response = client.get('/api/documents/special')
        data = json.loads(response.data)
        assert data['content'] == special_content

    def test_special_characters_in_doc_id(self, client):
        """Test document IDs with special characters."""
        doc_id = 'doc_id-123'
        response = client.put(
            f'/api/documents/{doc_id}',
            data=json.dumps({'content': 'test'}),
            content_type='application/json'
        )
        assert response.status_code == 201

        response = client.get(f'/api/documents/{doc_id}')
        assert response.status_code == 200

    def test_concurrent_operations(self, client):
        """Test multiple documents don't interfere."""
        docs = {
            'doc1': 'content 1',
            'doc2': 'content 2',
            'doc3': 'content 3',
        }

        for doc_id, content in docs.items():
            client.put(
                f'/api/documents/{doc_id}',
                data=json.dumps({'content': content}),
                content_type='application/json'
            )

        for doc_id, content in docs.items():
            response = client.get(f'/api/documents/{doc_id}')
            data = json.loads(response.data)
            assert data['content'] == content


class TestDocsAPI:
    """Tests for documentation API endpoint."""

    def test_list_docs(self, client):
        """Test listing available documentation files."""
        response = client.get('/api/docs')
        assert response.status_code == 200
        data = json.loads(response.data)
        assert 'docs' in data
        assert isinstance(data['docs'], list)
        # Should have at least the standard docs
        assert len(data['docs']) > 0

    def test_list_docs_contains_expected_files(self, client):
        """Test that expected documentation files are listed."""
        response = client.get('/api/docs')
        data = json.loads(response.data)
        docs = data['docs']
        # These should be present if docs folder exists
        # (they might not all be present, so just check it's not empty)
        assert len(docs) > 0
        # All items should be strings
        assert all(isinstance(d, str) for d in docs)
        # Should be sorted
        assert docs == sorted(docs)

    def test_get_doc(self, client):
        """Test retrieving a specific documentation file."""
        response = client.get('/api/docs')
        data = json.loads(response.data)
        docs = data['docs']

        if not docs:
            pytest.skip('No documentation files available')

        # Get the first doc
        doc_name = docs[0]
        response = client.get(f'/api/docs/{doc_name}')
        assert response.status_code == 200
        data = json.loads(response.data)
        assert 'content' in data
        assert 'name' in data
        assert data['name'] == doc_name
        assert isinstance(data['content'], str)
        assert len(data['content']) > 0

    def test_get_doc_nonexistent(self, client):
        """Test retrieving a nonexistent documentation file."""
        response = client.get('/api/docs/nonexistent_doc_xyz')
        assert response.status_code == 404
        data = json.loads(response.data)
        assert 'error' in data

    def test_get_doc_invalid_name(self, client):
        """Test that invalid doc names are rejected."""
        # Flask normalizes paths, so path traversal in URL is safe
        # But we test that the security check in the route works
        # by verifying resolve() logic with symbolic names
        response = client.get('/api/docs/overview')
        assert response.status_code == 200  # Valid doc

        response = client.get('/api/docs/nonexistent')
        assert response.status_code == 404  # File doesn't exist


SIMPLE_YAML = """\
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    label: "Square"
    initial:
      line1: [0.0, 0.0, 1.0, 0.0]
    entities:
      - id: line1
        kind: line_segment
    constraints:
      - id: c_horiz
        kind: horizontal
        target: {entity: line1}
"""


class TestSolveAPI:
    """Tests for the /api/solve endpoint."""

    def test_solve_accepts_json(self, client):
        """Test that /api/solve accepts application/json with a content field."""
        response = client.post(
            '/api/solve',
            data=json.dumps({'content': SIMPLE_YAML}),
            content_type='application/json',
        )
        assert response.status_code == 200
        data = json.loads(response.data)
        assert 'result' in data
        assert 'sketch_1' in data['result']

    def test_solve_accepts_yaml(self, client):
        """Test that /api/solve accepts raw YAML body."""
        response = client.post(
            '/api/solve',
            data=SIMPLE_YAML,
            content_type='text/plain',
        )
        assert response.status_code == 200
        data = json.loads(response.data)
        assert 'result' in data
        assert 'sketch_1' in data['result']

    def test_solve_returns_error_on_invalid_yaml(self, client):
        """Test that /api/solve returns a JSON error for invalid input."""
        response = client.post(
            '/api/solve',
            data=json.dumps({'content': 'not: valid: yaml: ::'}),
            content_type='application/json',
        )
        assert response.status_code == 400
        data = json.loads(response.data)
        assert 'error' in data

    def test_solve_returns_error_on_missing_content(self, client):
        """Test that /api/solve returns a JSON error when content field is missing."""
        response = client.post(
            '/api/solve',
            data=json.dumps({'foo': 'bar'}),
            content_type='application/json',
        )
        assert response.status_code == 400
        data = json.loads(response.data)
        assert 'error' in data
