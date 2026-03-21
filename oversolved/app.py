"""Flask application for the Oversolved solver API."""

from pathlib import Path
import yaml
from flask import Flask, g, jsonify, request, send_from_directory
from oversolved.db import Database, SQLiteConnection, MariaDBConnection, DocumentStore
from oversolved.solver import solve


def _get_database(config):
    """Create a database connection based on config."""
    if config['type'] == 'sqlite':
        db_conn = SQLiteConnection(config['path'])
    elif config['type'] == 'mariadb':
        db_conn = MariaDBConnection(
            host=config['host'],
            user=config['user'],
            password=config['password'],
            database=config['name'],
        )
    else:
        raise ValueError(f"Unknown database type: {config['type']}")
    return Database(db_conn)


def create_app(config=None):
    """Create and configure the Flask app."""
    app = Flask(__name__)

    # Default config
    app.config.update({
        'DB_TYPE': 'sqlite',
        'DB_PATH': ':memory:',
        'JSON_SORT_KEYS': False,
    })

    if config:
        app.config.update(config)

    # Store config for later connection creation
    app.db_config = {
        'type': app.config['DB_TYPE'],
        'path': app.config.get('DB_PATH', ':memory:'),
        'host': app.config.get('DB_HOST'),
        'user': app.config.get('DB_USER'),
        'password': app.config.get('DB_PASSWORD'),
        'name': app.config.get('DB_NAME'),
    }

    # Initialize database once for migrations
    db = _get_database(app.db_config)
    _register_migrations(db)
    db.init()
    db.close()

    def get_db():
        """Get or create database connection for this request."""
        if 'db' not in g:
            g.db = _get_database(app.db_config)
            _register_migrations(g.db)
            g.db.init()
        return g.db

    app.get_db = get_db

    @app.before_request
    def before_request():
        """Ensure database connection is available."""
        get_db()

    # Routes
    @app.route('/api/documents/<doc_id>', methods=['GET'])
    def get_document(doc_id):
        """Retrieve a YAML document."""
        db = app.get_db()
        doc_store = DocumentStore(db)
        content = doc_store.retrieve(doc_id)
        if content is None:
            return jsonify({'error': 'Document not found'}), 404
        return jsonify({'id': doc_id, 'content': content})

    @app.route('/api/documents/<doc_id>', methods=['PUT', 'POST'])
    def store_document(doc_id):
        """Store or update a YAML document."""
        if not request.is_json:
            return jsonify({'error': 'Content-Type must be application/json'}), 400

        data = request.get_json()
        if 'content' not in data:
            return jsonify({'error': 'Missing "content" field'}), 400

        content = data['content']
        if not isinstance(content, str):
            return jsonify({'error': '"content" must be a string'}), 400

        db = app.get_db()
        doc_store = DocumentStore(db)
        doc_store.store(doc_id, content)
        return jsonify({'id': doc_id, 'status': 'stored'}), 201

    @app.route('/api/documents/<doc_id>', methods=['DELETE'])
    def delete_document(doc_id):
        """Delete a document."""
        db = app.get_db()
        doc_store = DocumentStore(db)
        deleted = doc_store.delete(doc_id)
        if not deleted:
            return jsonify({'error': 'Document not found'}), 404
        return jsonify({'id': doc_id, 'status': 'deleted'}), 200

    @app.route('/api/documents', methods=['GET'])
    def list_documents():
        """List all document IDs."""
        db = app.get_db()
        doc_store = DocumentStore(db)
        ids = doc_store.list_ids()
        return jsonify({'documents': ids})

    @app.route('/api/solve', methods=['POST'])
    def solve_document():
        """Run the solver on a structured document object and return the result.
        Accepts application/json with the parsed document structure.
        """
        content_type = request.content_type or ''

        if 'application/json' not in content_type:
            return jsonify({'error': 'Content-Type must be application/json'}), 400

        data = request.get_json()
        if not data:
            return jsonify({'error': 'Empty request body'}), 400

        try:
            # Convert parsed object back to YAML for the solver
            yaml_str = yaml.dump(data)
            result = solve(yaml_str)
            return jsonify({'result': result})
        except Exception as e:
            return jsonify({'error': str(e)}), 400

    @app.route('/api/docs', methods=['GET'])
    def list_docs():
        """List available documentation files."""
        docs_path = Path(__file__).parent.parent / 'docs'
        if not docs_path.exists():
            return jsonify({'docs': []})
        md_files = sorted([f.stem for f in docs_path.glob('*.md')])
        return jsonify({'docs': md_files})

    @app.route('/api/docs/<doc_name>', methods=['GET'])
    def get_doc(doc_name):
        """Retrieve a markdown documentation file."""
        docs_path = Path(__file__).parent.parent / 'docs'
        file_path = docs_path / f'{doc_name}.md'

        # Security: ensure the file is within the docs directory
        try:
            file_path = file_path.resolve()
            docs_path = docs_path.resolve()
            if not str(file_path).startswith(str(docs_path)):
                return jsonify({'error': 'Invalid doc name'}), 400
        except (OSError, ValueError):
            return jsonify({'error': 'Invalid doc name'}), 400

        if not file_path.exists():
            return jsonify({'error': 'Documentation not found'}), 404

        try:
            content = file_path.read_text(encoding='utf-8')
            return jsonify({'name': doc_name, 'content': content})
        except OSError:
            return jsonify({'error': 'Failed to read documentation'}), 500

    # Serve frontend
    frontend_dist = Path(__file__).parent.parent / 'frontend' / 'dist'
    if frontend_dist.exists():
        @app.route('/')
        @app.route('/<path:path>')
        def serve_frontend(path='index.html'):
            """Serve the frontend."""
            if path and (frontend_dist / path).exists():
                return send_from_directory(frontend_dist, path)
            return send_from_directory(frontend_dist, 'index.html')

    @app.teardown_appcontext
    def close_db(error):
        """Close database connection after request."""
        db = g.pop('db', None)
        if db is not None:
            db.close()

    return app


def _register_migrations(db: Database) -> None:
    """Register all database migrations."""

    def migration_001_create_documents_table(database: Database):
        """Create the documents table."""
        database.execute("""
            CREATE TABLE IF NOT EXISTS documents (
                id VARCHAR(255) PRIMARY KEY,
                content LONGTEXT NOT NULL
            )
        """)

    db.register_migration(1, 'create_documents_table', migration_001_create_documents_table)


if __name__ == '__main__':
    app = create_app()
    app.run(debug=True)
