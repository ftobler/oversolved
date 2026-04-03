"""Flask application for the Oversolved solver API."""

from functools import wraps
from pathlib import Path
from datetime import datetime
import re
import yaml
from flask import Flask, g, jsonify, request, send_from_directory, make_response
from werkzeug.security import generate_password_hash, check_password_hash
from oversolved.db import Database, SQLiteConnection, MariaDBConnection, DocumentStore, UserStore, SessionStore
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


def _ensure_admin_user(db: Database) -> None:
    """Create the default admin user if it doesn't exist."""
    user_store = UserStore(db)
    if user_store.find_by_username('admin') is None:
        user_store.create('admin', generate_password_hash('admin'), must_change_password=True)


def create_app(config=None):
    """Create and configure the Flask app."""
    app = Flask(__name__)

    app.config.update({
        'DB_TYPE': 'sqlite',
        'DB_PATH': ':memory:',
        'JSON_SORT_KEYS': False,
    })

    if config:
        app.config.update(config)

    app.db_config = {
        'type': app.config['DB_TYPE'],
        'path': app.config.get('DB_PATH', ':memory:'),
        'host': app.config.get('DB_HOST'),
        'user': app.config.get('DB_USER'),
        'password': app.config.get('DB_PASSWORD'),
        'name': app.config.get('DB_NAME'),
    }

    # Initialize database, run migrations, seed admin user
    db = _get_database(app.db_config)
    _register_migrations(db)
    db.init()
    _ensure_admin_user(db)
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
        get_db()

    def require_auth(f):
        """Decorator that requires a valid session cookie."""
        @wraps(f)
        def decorated(*args, **kwargs):
            token = request.cookies.get('session_token')
            if not token:
                return jsonify({'error': 'Not authenticated'}), 401
            db = get_db()
            session = SessionStore(db).find(token)
            if session is None:
                return jsonify({'error': 'Invalid or expired session'}), 401
            user = UserStore(db).find_by_id(session['user_id'])
            if user is None:
                return jsonify({'error': 'User not found'}), 401
            g.current_user = user
            return f(*args, **kwargs)
        return decorated

    # ── Auth routes ────────────────────────────────────────────────────────────

    @app.route('/api/auth/login', methods=['POST'])
    def login():
        if not request.is_json:
            return jsonify({'error': 'Content-Type must be application/json'}), 400
        data = request.get_json()
        username = (data.get('username') or '').strip()
        password = data.get('password') or ''
        if not username or not password:
            return jsonify({'error': 'Username and password required'}), 400
        db = get_db()
        user = UserStore(db).find_by_username(username)
        if user is None or not check_password_hash(user['password_hash'], password):
            return jsonify({'error': 'Invalid credentials'}), 401
        token = SessionStore(db).create(user['id'])
        response = make_response(jsonify({
            'user': {
                'id': user['id'],
                'username': user['username'],
                'must_change_password': user['must_change_password'],
            }
        }))
        response.set_cookie(
            'session_token', token,
            httponly=True, samesite='Lax', max_age=60 * 60 * 24 * 30
        )
        return response

    @app.route('/api/auth/logout', methods=['POST'])
    def logout():
        token = request.cookies.get('session_token')
        if token:
            SessionStore(get_db()).delete(token)
        response = make_response(jsonify({'status': 'logged_out'}))
        response.delete_cookie('session_token')
        return response

    @app.route('/api/auth/me', methods=['GET'])
    def me():
        token = request.cookies.get('session_token')
        if not token:
            return jsonify({'error': 'Not authenticated'}), 401
        db = get_db()
        session = SessionStore(db).find(token)
        if session is None:
            return jsonify({'error': 'Invalid or expired session'}), 401
        user = UserStore(db).find_by_id(session['user_id'])
        if user is None:
            return jsonify({'error': 'User not found'}), 401
        return jsonify({
            'user': {
                'id': user['id'],
                'username': user['username'],
                'must_change_password': user['must_change_password'],
            }
        })

    # ── Document routes ────────────────────────────────────────────────────────

    @app.route('/api/documents', methods=['GET'])
    @require_auth
    def list_documents():
        docs = DocumentStore(get_db()).list_by_owner(g.current_user['id'])
        return jsonify({'documents': docs})

    @app.route('/api/documents', methods=['POST'])
    @require_auth
    def create_document():
        if not request.is_json:
            return jsonify({'error': 'Content-Type must be application/json'}), 400
        data = request.get_json()
        name = (data.get('name') or '').strip()
        if not name:
            return jsonify({'error': 'Document name required'}), 400
        uuid = DocumentStore(get_db()).create(name, g.current_user['id'])
        return jsonify({'uuid': uuid, 'name': name}), 201

    @app.route('/api/documents/<uuid>', methods=['GET'])
    @require_auth
    def get_document(uuid):
        doc = DocumentStore(get_db()).retrieve(uuid)
        if doc is None:
            return jsonify({'error': 'Document not found'}), 404
        if doc['owner_id'] != g.current_user['id']:
            return jsonify({'error': 'Forbidden'}), 403
        return jsonify({'uuid': doc['uuid'], 'name': doc['name'], 'content': doc['content']})

    @app.route('/api/documents/<uuid>', methods=['PUT'])
    @require_auth
    def update_document(uuid):
        if not request.is_json:
            return jsonify({'error': 'Content-Type must be application/json'}), 400
        data = request.get_json()
        if 'content' not in data:
            return jsonify({'error': 'Missing "content" field'}), 400
        content = data['content']
        if not isinstance(content, str):
            return jsonify({'error': '"content" must be a string'}), 400
        db = get_db()
        doc_store = DocumentStore(db)
        doc = doc_store.retrieve(uuid)
        if doc is None:
            # Create document if it doesn't exist (upsert)
            doc_store.create_with_uuid(uuid, uuid, g.current_user['id'])
        else:
            if doc['owner_id'] != g.current_user['id']:
                return jsonify({'error': 'Forbidden'}), 403
        doc_store.store_content(uuid, content)
        return jsonify({'uuid': uuid, 'status': 'stored'}), 200

    @app.route('/api/documents/<uuid>', methods=['PATCH'])
    @require_auth
    def rename_document(uuid):
        if not request.is_json:
            return jsonify({'error': 'Content-Type must be application/json'}), 400
        data = request.get_json()
        name = (data.get('name') or '').strip()
        if not name:
            return jsonify({'error': 'Document name required'}), 400
        db = get_db()
        doc = DocumentStore(db).retrieve(uuid)
        if doc is None:
            return jsonify({'error': 'Document not found'}), 404
        if doc['owner_id'] != g.current_user['id']:
            return jsonify({'error': 'Forbidden'}), 403
        DocumentStore(db).rename(uuid, name)
        return jsonify({'uuid': uuid, 'name': name})

    @app.route('/api/documents/<uuid>', methods=['DELETE'])
    @require_auth
    def delete_document(uuid):
        db = get_db()
        doc = DocumentStore(db).retrieve(uuid)
        if doc is None:
            return jsonify({'error': 'Document not found'}), 404
        if doc['owner_id'] != g.current_user['id']:
            return jsonify({'error': 'Forbidden'}), 403
        DocumentStore(db).delete(uuid)
        return jsonify({'uuid': uuid, 'status': 'deleted'}), 200

    # ── Solver ─────────────────────────────────────────────────────────────────

    @app.route('/api/solve', methods=['POST'])
    def solve_document():
        content_type = request.content_type or ''
        if 'application/json' not in content_type:
            return jsonify({'error': 'Content-Type must be application/json'}), 400
        data = request.get_json()
        if not data:
            return jsonify({'error': 'Empty request body'}), 400
        try:
            yaml_str = yaml.dump(data)
            result = solve(yaml_str)
            return jsonify(result)
        except Exception as e:
            return jsonify({'error': str(e)}), 400

    @app.route('/api/bug-report', methods=['POST'])
    def submit_bug_report():
        content_type = request.content_type or ''
        if 'application/json' not in content_type:
            return jsonify({'error': 'Content-Type must be application/json'}), 400
        data = request.get_json()
        if not data:
            return jsonify({'error': 'Empty request body'}), 400
        title = (data.get('title') or '').strip()
        description = (data.get('description') or '').strip()
        if not title or not description:
            return jsonify({'error': 'Title and description are required'}), 400

        bugreports_dir = Path(__file__).parent.parent / 'bugreports'
        bugreports_dir.mkdir(exist_ok=True)

        safe_title = re.sub(r'[^a-z0-9]+', '_', title.lower()).strip('_')[:50]
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f"{safe_title}_{timestamp}.md"
        filepath = bugreports_dir / filename

        ast_yaml = yaml.dump(data.get('ast'), default_flow_style=False) if data.get('ast') else 'N/A'
        selection = data.get('selection') or []
        solve_results = data.get('solveResults')
        internal_state = data.get('internalState') or {}

        markdown = f"""# Bug Report: {title}

**Timestamp:** {datetime.now().isoformat()}

## Description

{description}

## Internal State

- **Mode:** {internal_state.get('mode', 'N/A')}
- **Active Tool:** {internal_state.get('activeTool', 'N/A')}
- **Editing Feature:** {internal_state.get('editingFeatureId', 'N/A')}
- **Active Sketch:** {internal_state.get('activeSketchFeatureId', 'N/A')}

## Selection

{f"**{len(selection)} item(s) selected:**" if selection else "**No selection**"}

```
{chr(10).join(selection) if selection else "(empty)"}
```

## AST (Document)

```yaml
{ast_yaml}
```

## Solver Result

{f"```yaml{chr(10)}{yaml.dump(solve_results, default_flow_style=False)}{chr(10)}```" if solve_results else "*(not available)*"}

---

*Report generated by Oversolved bug reporter*
"""

        try:
            filepath.write_text(markdown, encoding='utf-8')
            return jsonify({'status': 'saved', 'filename': filename}), 201
        except Exception as e:
            return jsonify({'error': f'Failed to save report: {e}'}), 500

    # ── Documentation ──────────────────────────────────────────────────────────

    @app.route('/api/docs', methods=['GET'])
    def list_docs():
        docs_path = Path(__file__).parent.parent / 'docs'
        if not docs_path.exists():
            return jsonify({'docs': []})
        md_files = sorted([f.stem for f in docs_path.glob('*.md')])
        return jsonify({'docs': md_files})

    @app.route('/api/docs/<doc_name>', methods=['GET'])
    def get_doc(doc_name):
        docs_path = Path(__file__).parent.parent / 'docs'
        file_path = docs_path / f'{doc_name}.md'
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

    # ── Frontend ───────────────────────────────────────────────────────────────

    frontend_dist = Path(__file__).parent.parent / 'frontend' / 'dist'
    if frontend_dist.exists():
        @app.route('/')
        @app.route('/<path:path>')
        def serve_frontend(path='index.html'):
            if path and (frontend_dist / path).exists():
                return send_from_directory(frontend_dist, path)
            return send_from_directory(frontend_dist, 'index.html')

    @app.teardown_appcontext
    def close_db(error):
        db = g.pop('db', None)
        if db is not None:
            db.close()

    return app


def _register_migrations(db: Database) -> None:
    """Register all database migrations."""

    def migration_001_initial_schema(database: Database):
        """Create users, sessions, and documents tables."""
        database.execute("""
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                must_change_password INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        database.execute("""
            CREATE TABLE sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                expires_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        """)
        database.execute("""
            CREATE TABLE documents (
                uuid TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                content TEXT NOT NULL,
                owner_id INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (owner_id) REFERENCES users(id)
            )
        """)

    db.register_migration(1, 'initial_schema', migration_001_initial_schema)


if __name__ == '__main__':
    app = create_app()
    app.run(debug=True)
