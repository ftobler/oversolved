"""Flask application for the Oversolved solver API."""

import json
import os
import uuid
from functools import wraps
from pathlib import Path
from datetime import datetime, timedelta
import re
import atexit
import yaml
import zipfile
from io import BytesIO
from PIL import Image
from flask import (
    Flask,
    Response,
    g,
    jsonify,
    request,
    send_file,
    send_from_directory,
    make_response,
)
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
from oversolved.db import (
    Database,
    SQLiteConnection,
    MariaDBConnection,
    DocumentStore,
    UserStore,
    SessionStore,
    PeriodicTaskStore,
)

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
ALLOWED_EXTENSIONS = {".step", ".stp", ".iges", ".igs"}


def _get_database(config):
    """Create a database connection based on config."""
    if config["type"] == "sqlite":
        db_conn = SQLiteConnection(config["path"])
    elif config["type"] == "mariadb":
        db_conn = MariaDBConnection(
            host=config["host"],
            user=config["user"],
            password=config["password"],
            database=config["name"],
        )
    else:
        raise ValueError(f"Unknown database type: {config['type']}")
    return Database(db_conn)


def _ensure_admin_user(db: Database) -> None:
    """Create the default admin user if it doesn't exist."""
    user_store = UserStore(db)
    admin = user_store.find_by_username("admin")
    if admin:
        user_store.update(admin["id"], is_admin=1)
    else:
        uid = user_store.create(
            "admin", generate_password_hash("admin"),
            must_change_password=True, email="admin@local.oversolved",
        )
        user_store.update(uid, is_admin=1, must_change_password=1)


_task_scheduler = None


def init_scheduler(app):
    """Initialize and start the periodic task scheduler."""
    global _task_scheduler
    from oversolved.periodic_tasks import TaskScheduler, EmptyTrashTask

    db_config = {
        "type": app.config["DB_TYPE"],
        "path": app.config.get("DB_PATH", ":memory:"),
        "host": app.config.get("DB_HOST"),
        "user": app.config.get("DB_USER"),
        "password": app.config.get("DB_PASSWORD"),
        "name": app.config.get("DB_NAME"),
    }

    db = _get_database(db_config)
    _register_migrations(db)
    db.init()

    def db_factory():
        d = _get_database(db_config)
        _register_migrations(d)
        d.init()
        return d

    _task_scheduler = TaskScheduler(db_factory)
    _task_scheduler.register_task(EmptyTrashTask())
    _task_scheduler.start()

    def shutdown_scheduler():
        if _task_scheduler:
            _task_scheduler.stop()

    atexit.register(shutdown_scheduler)


def create_app(config: dict | None = None) -> Flask:
    """Create and configure the Flask app."""
    app = Flask(__name__)

    app.config.update(
        {
            "DB_TYPE": "sqlite",
            "DB_PATH": ":memory:",
            "JSON_SORT_KEYS": False,
            "L2_CACHE_ENABLED": True,
            "L2_CACHE_DIR": "/tmp/oversolved_l2_cache",
            "L2_CACHE_MAX_SIZE": 5 * 1024 * 1024 * 1024,  # 5 GB
            "L2_CACHE_TTL": 86400 * 30,  # 30 days
        }
    )

    if config:
        app.config.update(config)

    db_config = {
        "type": app.config["DB_TYPE"],
        "path": app.config.get("DB_PATH", ":memory:"),
        "host": app.config.get("DB_HOST"),
        "user": app.config.get("DB_USER"),
        "password": app.config.get("DB_PASSWORD"),
        "name": app.config.get("DB_NAME"),
    }

    # Initialize database, run migrations, seed admin user
    db = _get_database(db_config)
    _register_migrations(db)
    db.init()
    _ensure_admin_user(db)
    db.close()

    # Start periodic task scheduler (skip in testing to avoid threading issues)
    if not app.config.get("TESTING"):
        init_scheduler(app)

    def get_db():
        """Get or create database connection for this request."""
        if "db" not in g:
            g.db = _get_database(db_config)
            _register_migrations(g.db)
            g.db.init()
        return g.db

    @app.before_request
    def before_request():
        get_db()

    def require_auth(f):
        """Decorator that requires a valid session cookie."""

        @wraps(f)
        def decorated(*args, **kwargs):
            token = request.cookies.get("session_token")
            if not token:
                return jsonify({"error": "Not authenticated"}), 401
            db = get_db()
            session = SessionStore(db).find(token)
            if session is None:
                return jsonify({"error": "Invalid or expired session"}), 401
            user = UserStore(db).find_by_id(session["user_id"])
            if user is None:
                return jsonify({"error": "User not found"}), 401
            g.current_user = user
            return f(*args, **kwargs)

        return decorated

    # ── Auth routes ────────────────────────────────────────────────────────────

    @app.route("/api/auth/login", methods=["POST"])
    def login():
        if not request.is_json:
            return jsonify({"error": "Content-Type must be application/json"}), 400
        data = request.get_json()
        credential = (data.get("credential") or data.get("username") or "").strip()
        password = data.get("password") or ""
        if not credential or not password:
            return jsonify({"error": "Credential and password required"}), 400
        db = get_db()
        user_store = UserStore(db)
        user = (
            user_store.find_by_username(credential)
            or user_store.find_by_email(credential)
        )
        if user is None or not check_password_hash(user["password_hash"], password):
            return jsonify({"error": "Invalid credentials"}), 401
        if not user["is_active"]:
            return jsonify({"error": "Account is deactivated"}), 403
        user_store.update(user["id"], last_login_at=datetime.now().isoformat())
        token = SessionStore(db).create(user["id"])
        response = make_response(
            jsonify(
                {
                    "user": {
                        "id": user["id"],
                        "username": user["username"],
                        "email": user.get("email"),
                        "must_change_password": user["must_change_password"],
                        "is_admin": user["is_admin"],
                        "is_active": user["is_active"],
                        "last_login_at": user.get("last_login_at"),
                    }
                }
            )
        )
        response.set_cookie(
            "session_token",
            token,
            httponly=True,
            samesite="Lax",
            max_age=60 * 60 * 24 * 30,
        )
        return response

    @app.route("/api/auth/logout", methods=["POST"])
    def logout():
        token = request.cookies.get("session_token")
        if token:
            SessionStore(get_db()).delete(token)
        response = make_response(jsonify({"status": "logged_out"}))
        response.delete_cookie("session_token")
        return response

    @app.route("/api/auth/me", methods=["GET"])
    def me():
        token = request.cookies.get("session_token")
        if not token:
            return jsonify({"error": "Not authenticated"}), 401
        db = get_db()
        session = SessionStore(db).find(token)
        if session is None:
            return jsonify({"error": "Invalid or expired session"}), 401
        user = UserStore(db).find_by_id(session["user_id"])
        if user is None:
            return jsonify({"error": "User not found"}), 401
        return jsonify(
            {
                "user": {
                    "id": user["id"],
                    "username": user["username"],
                    "email": user.get("email") or "",
                    "must_change_password": user["must_change_password"],
                    "is_admin": user["is_admin"],
                    "is_active": user["is_active"],
                    "last_login_at": user.get("last_login_at"),
                }
            }
        )

    def require_admin(f):
        """Decorator that requires the current user to be an admin."""

        @wraps(f)
        def decorated_function(*args, **kwargs):
            if not g.current_user.get("is_admin"):
                return jsonify({"error": "Admin access required"}), 403
            return f(*args, **kwargs)

        return decorated_function

    @app.route("/api/users/me", methods=["PUT"])
    @require_auth
    def update_profile():
        if not request.is_json:
            return jsonify({"error": "Content-Type must be application/json"}), 400
        data = request.get_json()
        username = data.get("username")
        email = data.get("email")
        current_password = data.get("current_password", "")
        new_password = data.get("new_password", "")

        db = get_db()
        user_store = UserStore(db)
        user_id = g.current_user["id"]

        updates = {}
        if username and username.strip():
            updates["username"] = username.strip()

        if email and email.strip():
            updates["email"] = email.strip()

        if new_password:
            if not current_password:
                return jsonify({"error": "Current password required to change password"}), 400
            user = user_store.find_by_id(user_id)
            if user is None:
                return jsonify({"error": "User not found"}), 404
            full_user = user_store.find_by_username(user["username"])
            if full_user is None or not check_password_hash(full_user["password_hash"], current_password):
                return jsonify({"error": "Current password is incorrect"}), 400
            updates["password_hash"] = generate_password_hash(new_password)
            updates["must_change_password"] = 0

        if updates:
            success = user_store.update(user_id, **updates)
            if not success:
                return jsonify({"error": "User not found"}), 404

        return jsonify({"status": "updated"})

    _VALID_SORT_PREFS = {"alphabetical", "date_newest_first", "date_oldest_first"}

    @app.route("/api/users/me/preferences", methods=["GET"])
    @require_auth
    def get_preferences():
        user_id = g.current_user["id"]
        user = UserStore(get_db()).find_by_id(user_id)
        if user is None:
            return jsonify({"error": "User not found"}), 404
        return jsonify({
            "document_sort": user.get("document_sort_preference", "alphabetical")
        })

    @app.route("/api/users/me/preferences", methods=["PUT"])
    @require_auth
    def update_preferences():
        if not request.is_json:
            return jsonify({"error": "Content-Type must be application/json"}), 400
        data = request.get_json()
        document_sort = data.get("document_sort", "").strip()
        if not document_sort:
            return jsonify({"error": "document_sort is required"}), 400
        if document_sort not in _VALID_SORT_PREFS:
            return jsonify({"error": "Invalid document_sort value"}), 400
        user_id = g.current_user["id"]
        success = UserStore(get_db()).update(user_id, document_sort_preference=document_sort)
        if not success:
            return jsonify({"error": "User not found"}), 404
        return jsonify({"status": "updated", "document_sort": document_sort})

    @app.route("/api/admin/users", methods=["GET"])
    @require_auth
    @require_admin
    def list_users():
        users = UserStore(get_db()).list_all()
        return jsonify({"users": users})

    @app.route("/api/admin/users", methods=["POST"])
    @require_auth
    @require_admin
    def create_user_admin():
        if not request.is_json:
            return jsonify({"error": "Content-Type must be application/json"}), 400
        data = request.get_json()
        username = (data.get("username") or "").strip()
        email = (data.get("email") or "").strip()
        password = data.get("password") or ""
        is_admin = bool(data.get("is_admin", False))

        if not username or not password:
            return jsonify({"error": "Username and password required"}), 400
        if not email:
            return jsonify({"error": "Email required"}), 400

        db = get_db()
        user_store = UserStore(db)
        if user_store.find_by_username(username):
            return jsonify({"error": "Username already exists"}), 409
        if user_store.find_by_email(email):
            return jsonify({"error": "Email already exists"}), 409

        uid = user_store.create(
            username, generate_password_hash(password),
            email=email,
            is_admin=is_admin,
        )
        return jsonify({"id": uid, "username": username, "email": email}), 201

    @app.route("/api/admin/users/<int:user_id>", methods=["PUT"])
    @require_auth
    @require_admin
    def admin_update_user(user_id):
        if not request.is_json:
            return jsonify({"error": "Content-Type must be application/json"}), 400
        data = request.get_json()

        if user_id == g.current_user["id"] and data.get("is_active") is False:
            return jsonify({"error": "Cannot deactivate yourself"}), 403
        if user_id == g.current_user["id"] and data.get("is_admin") is False:
            return jsonify({"error": "Cannot remove your own admin privileges"}), 403

        db = get_db()
        user_store = UserStore(db)

        updates = {}
        if "username" in data:
            updates["username"] = data["username"].strip()
        if "email" in data:
            updates["email"] = data["email"].strip() if data["email"] else None
        if "is_active" in data:
            updates["is_active"] = 1 if data["is_active"] else 0
        if "is_admin" in data:
            updates["is_admin"] = 1 if data["is_admin"] else 0

        if not updates:
            return jsonify({"error": "No fields to update"}), 400

        success = user_store.update(user_id, **updates)
        if not success:
            return jsonify({"error": "User not found"}), 404

        return jsonify({"status": "updated"})

    @app.route("/api/admin/users/<int:user_id>", methods=["DELETE"])
    @require_auth
    @require_admin
    def admin_delete_user(user_id):
        if user_id == g.current_user["id"]:
            return jsonify({"error": "Cannot delete yourself"}), 403

        db = get_db()
        user_store = UserStore(db)
        success = user_store.delete(user_id)
        if not success:
            return jsonify({"error": "User not found"}), 404
        return jsonify({"status": "deleted"})

    @app.route("/api/admin/users/<int:user_id>/reset", methods=["POST"])
    @require_auth
    @require_admin
    def admin_reset_password(user_id):
        if not request.is_json:
            return jsonify({"error": "Content-Type must be application/json"}), 400
        data = request.get_json()
        new_password = data.get("password") or ""
        if not new_password:
            return jsonify({"error": "Password required"}), 400

        db = get_db()
        user_store = UserStore(db)
        success = user_store.change_password(user_id, generate_password_hash(new_password))
        if not success:
            return jsonify({"error": "User not found"}), 404
        return jsonify({"status": "reset"})

    # ── Admin Periodic Task routes ─────────────────────────────────────────────

    @app.route("/api/admin/periodic-tasks", methods=["GET"])
    @require_auth
    @require_admin
    def list_periodic_tasks():
        """List all periodic tasks."""
        task_store = PeriodicTaskStore(get_db())
        tasks = task_store.find_all()
        return jsonify({"tasks": tasks})

    @app.route("/api/admin/periodic-tasks/<task_key>/run", methods=["POST"])
    @require_auth
    @require_admin
    def force_run_periodic_task(task_key):
        """Force execution of a periodic task."""
        if _task_scheduler is None:
            return jsonify({"error": "Scheduler not running"}), 503
        result = _task_scheduler.force_run_task(task_key)
        return jsonify(result)

    @app.route("/api/admin/backup", methods=["GET"])
    @require_auth
    @require_admin
    def backup_all_documents():
        """Create and download a backup of all documents on the server."""
        db = get_db()
        cursor = db.execute(
            "SELECT uuid, name, content, preview_image, owner_id FROM documents "
            "WHERE deleted_at IS NULL ORDER BY owner_id, name"
        )
        all_docs = cursor.fetchall()

        zip_buffer = BytesIO()
        with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zip_file:
            user_store = UserStore(db)
            file_counts = {}
            for doc_uuid, name, content, preview_image, owner_id in all_docs:
                user = user_store.find_by_id(owner_id)
                username = user["username"] if user else "unknown"
                doc_name = secure_filename(name)
                user_dir = f"{username}/"

                key = (username, doc_name)
                if key not in file_counts:
                    file_counts[key] = 0
                else:
                    file_counts[key] += 1

                if file_counts[key] > 0:
                    base, ext = doc_name.rsplit(".", 1) if "." in doc_name else (doc_name, "")
                    if ext:
                        doc_name = f"{base}_{file_counts[key]}.{ext}"
                    else:
                        doc_name = f"{doc_name}_{file_counts[key]}"

                zip_file.writestr(f'{user_dir}{doc_name}.yaml', content)
                if preview_image:
                    zip_file.writestr(f'{user_dir}{doc_name}.png', preview_image)

        zip_buffer.seek(0)
        return send_file(
            zip_buffer,
            mimetype='application/zip',
            as_attachment=True,
            download_name=f'oversolved-backup-{datetime.now().strftime("%Y-%m-%d")}.zip'
        )

    @app.route("/api/admin/import-backup", methods=["POST"])
    @require_auth
    @require_admin
    def import_backup():
        """Import documents from a backup zip file."""
        if "file" not in request.files:
            return jsonify({"error": "No file provided"}), 400

        file = request.files["file"]
        if not file.filename or not file.filename.endswith('.zip'):
            return jsonify({"error": "File must be a zip file"}), 400

        try:
            zip_buffer = BytesIO(file.read())
            db = get_db()
            user_store = UserStore(db)
            doc_store = DocumentStore(db)

            imported_count = 0
            skipped_count = 0
            errors = []

            with zipfile.ZipFile(zip_buffer, 'r') as zip_file:
                files_by_user = {}
                for file_info in zip_file.filelist:
                    path = file_info.filename
                    if path.endswith('/'):
                        continue

                    parts = path.split('/')
                    if len(parts) < 2:
                        errors.append(f"Invalid path structure: {path}")
                        continue

                    username = parts[0]
                    filename = parts[1]

                    if username not in files_by_user:
                        files_by_user[username] = {}
                    files_by_user[username][filename] = path

                for username, files in files_by_user.items():
                    user = user_store.find_by_username(username)
                    if user is None:
                        skipped_count += len(files)
                        errors.append(f"User not found: {username}")
                        continue

                    yaml_files = {k: v for k, v in files.items() if k.endswith('.yaml')}
                    for yaml_name, yaml_path in yaml_files.items():
                        doc_name = yaml_name[:-5]
                        try:
                            content = zip_file.read(yaml_path).decode('utf-8')

                            uuid = doc_store.create(doc_name, user["id"])
                            doc_store.store_content(uuid, content)

                            png_name = f"{doc_name}.png"
                            if png_name in files:
                                png_path = files[png_name]
                                preview_data = zip_file.read(png_path)
                                doc_store.store_preview_image(uuid, preview_data)

                            imported_count += 1
                        except Exception as e:
                            skipped_count += 1
                            errors.append(f"Failed to import {yaml_name}: {str(e)}")

            return jsonify({
                "status": "imported",
                "imported_count": imported_count,
                "skipped_count": skipped_count,
                "errors": errors if errors else None
            }), 200

        except zipfile.BadZipFile:
            return jsonify({"error": "Invalid zip file"}), 400
        except Exception as e:
            return jsonify({"error": f"Import failed: {str(e)}"}), 500

    # ── Org routes ─────────────────────────────────────────────────────────────

    # ── Document routes ────────────────────────────────────────────────────────

    @app.route("/api/documents", methods=["GET"])
    @require_auth
    def list_documents():
        sort = request.args.get("sort", "name")
        search_query = request.args.get("search", "").strip()

        # Backward-compat for old include_shared param
        include_shared = request.args.get("include_shared", "").lower()
        filter_type = request.args.get("filter", "")
        if not filter_type:
            filter_type = "all" if include_shared in ("", "true") else "owned"

        docs = DocumentStore(get_db()).list_by_filter(
            g.current_user["id"], filter_type, sort, search_query
        )
        for doc in docs:
            if doc.get("preview_image"):
                del doc["preview_image"]
        return jsonify({"documents": docs})

    @app.route("/api/documents", methods=["POST"])
    @require_auth
    def create_document():
        if not request.is_json:
            return jsonify({"error": "Content-Type must be application/json"}), 400
        data = request.get_json()
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Document name required"}), 400
        db = get_db()
        doc_uuid = DocumentStore(db).create(name, g.current_user["id"])
        return jsonify({"uuid": doc_uuid, "name": name}), 201

    @app.route("/api/documents/<uuid>", methods=["GET"])
    @require_auth
    def get_document(uuid):
        doc_store = DocumentStore(get_db())
        doc = doc_store.retrieve(uuid)
        if doc is None:
            return jsonify({"error": "Document not found"}), 404
        permission = doc_store.get_permission(uuid, g.current_user["id"])
        if permission is None:
            return jsonify({"error": "Forbidden"}), 403
        user_store = UserStore(get_db())
        owner = user_store.find_by_id(doc["owner_id"])
        owner_username = owner["username"] if owner else "Unknown"
        response = {
            "uuid": doc["uuid"],
            "name": doc["name"],
            "content": doc["content"],
            "permission": permission,
            "owner_username": owner_username,
            "is_public": doc["is_public"],
        }
        if doc["preview_image"]:
            import base64

            response["preview_image"] = base64.b64encode(doc["preview_image"]).decode(
                "utf-8"
            )
        return jsonify(response)

    @app.route("/api/documents/<uuid>", methods=["PUT"])
    @require_auth
    def update_document(uuid):
        if not request.is_json:
            return jsonify({"error": "Content-Type must be application/json"}), 400
        data = request.get_json()
        if "content" not in data:
            return jsonify({"error": 'Missing "content" field'}), 400
        content = data["content"]
        if not isinstance(content, str):
            return jsonify({"error": '"content" must be a string'}), 400
        db = get_db()
        doc_store = DocumentStore(db)
        doc = doc_store.retrieve(uuid)
        if doc is None:
            # Create document if it doesn't exist (upsert)
            doc_store.create_with_uuid(uuid, uuid, g.current_user["id"])
        else:
            permission = doc_store.get_permission(uuid, g.current_user["id"])
            if permission not in ("owner", "edit"):
                return jsonify({"error": "Forbidden"}), 403
        doc_store.store_content(uuid, content)
        if data.get("preview_image"):
            import base64

            image_data = base64.b64decode(data["preview_image"])
            try:
                img = Image.open(BytesIO(image_data))
                if img.width > 512 or img.height > 512:
                    return jsonify(
                        {"error": "Preview image must be at most 512x512 pixels"}
                    ), 400
            except Exception:
                return jsonify({"error": "Invalid image data"}), 400
            doc_store.store_preview_image(uuid, image_data)
        return jsonify({"uuid": uuid, "status": "stored"}), 200

    @app.route("/api/documents/<uuid>", methods=["PATCH"])
    @require_auth
    def rename_document(uuid):
        if not request.is_json:
            return jsonify({"error": "Content-Type must be application/json"}), 400
        data = request.get_json()
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Document name required"}), 400
        db = get_db()
        doc_store = DocumentStore(db)
        doc = doc_store.retrieve(uuid)
        if doc is None:
            return jsonify({"error": "Document not found"}), 404
        permission = doc_store.get_permission(uuid, g.current_user["id"])
        if permission != "owner":
            return jsonify({"error": "Forbidden"}), 403
        doc_store.rename(uuid, name)
        return jsonify({"uuid": uuid, "name": name})

    @app.route("/api/documents/<uuid>", methods=["DELETE"])
    @require_auth
    def delete_document(uuid):
        db = get_db()
        doc_store = DocumentStore(db)
        doc = doc_store.retrieve(uuid)
        if doc is None:
            return jsonify({"error": "Document not found"}), 404
        permission = doc_store.get_permission(uuid, g.current_user["id"])
        if permission != "owner":
            return jsonify({"error": "Forbidden"}), 403
        deleted_at = datetime.now().isoformat()
        doc_store.update(uuid, deleted_at=deleted_at)
        return jsonify({
            "uuid": uuid,
            "status": "moved_to_trash",
            "deleted_at": deleted_at,
            "expires_at": (datetime.now() + timedelta(days=30)).isoformat()
        }), 200

    @app.route("/api/documents/trash", methods=["GET"])
    @require_auth
    def list_trash():
        """List soft-deleted documents owned by user."""
        docs = DocumentStore(get_db()).list_trash(g.current_user["id"])
        return jsonify({"documents": docs})

    @app.route("/api/documents/<uuid>/recover", methods=["POST"])
    @require_auth
    def recover_document(uuid):
        """Recover document from trash."""
        doc_store = DocumentStore(get_db())
        doc = doc_store.retrieve(uuid)

        if doc is None:
            return jsonify({"error": "Document not found"}), 404

        if doc["owner_id"] != g.current_user["id"]:
            return jsonify({"error": "Forbidden"}), 403

        if doc["deleted_at"] is None:
            return jsonify({"error": "Document is not in trash"}), 400

        # Check if 30 days have passed
        deleted_time = datetime.fromisoformat(doc["deleted_at"])
        if datetime.now() - deleted_time > timedelta(days=30):
            return jsonify({"error": "Document has expired and cannot be recovered"}), 410

        doc_store.update(uuid, deleted_at=None)
        return jsonify({"uuid": uuid, "status": "recovered", "deleted_at": None})

    @app.route("/api/documents/<uuid>/trash", methods=["DELETE"])
    @require_auth
    def permanently_delete_from_trash(uuid):
        """Permanently delete document from trash."""
        doc_store = DocumentStore(get_db())
        doc = doc_store.retrieve(uuid)

        if doc is None:
            return jsonify({"error": "Document not found"}), 404

        if doc["owner_id"] != g.current_user["id"]:
            return jsonify({"error": "Forbidden"}), 403

        if doc["deleted_at"] is None:
            return jsonify({"error": "Document is not in trash"}), 400

        # Permanent delete
        doc_store.permanently_delete(uuid)
        return jsonify({"uuid": uuid, "status": "permanently_deleted"})

    @app.route("/api/documents/<uuid>/duplicate", methods=["POST"])
    @require_auth
    def duplicate_document(uuid):
        db = get_db()
        doc_store = DocumentStore(db)
        doc = doc_store.retrieve(uuid)
        if doc is None:
            return jsonify({"error": "Document not found"}), 404
        permission = doc_store.get_permission(uuid, g.current_user["id"])
        if permission != "owner":
            return jsonify({"error": "Forbidden"}), 403
        new_name = f"{doc['name']} (Copy)"
        new_uuid = doc_store.duplicate(uuid, new_name)
        return jsonify({"uuid": new_uuid, "name": new_name}), 201

    @app.route("/api/documents/<uuid>/clone", methods=["POST"])
    @require_auth
    def clone_document(uuid):
        db = get_db()
        doc_store = DocumentStore(db)
        doc = doc_store.retrieve(uuid)
        if doc is None:
            return jsonify({"error": "Document not found"}), 404

        if not doc_store.has_permission(uuid, g.current_user["id"], "view"):
            return jsonify({"error": "Forbidden"}), 403

        new_name = f"{doc['name']} (Clone)"
        existing = doc_store.list_by_owner(g.current_user["id"])
        existing_names = {d["name"] for d in existing}
        counter = 1
        while new_name in existing_names:
            new_name = f"{doc['name']} (Clone {counter})"
            counter += 1

        new_uuid = doc_store.clone_document(uuid, g.current_user["id"], new_name)
        return jsonify({"uuid": new_uuid, "name": new_name}), 201

    @app.route("/api/documents/<uuid>/share", methods=["POST"])
    @require_auth
    def create_share(uuid):
        if not request.is_json:
            return jsonify({"error": "Content-Type must be application/json"}), 400
        data = request.get_json()
        db = get_db()
        doc_store = DocumentStore(db)
        doc = doc_store.retrieve(uuid)
        if doc is None:
            return jsonify({"error": "Document not found"}), 404
        if doc["owner_id"] != g.current_user["id"]:
            return jsonify({"error": "Forbidden"}), 403

        username = data.get("username")
        permission = data.get("permission", "view")
        if permission not in ("view", "edit"):
            return jsonify({"error": "Invalid permission"}), 400

        if username:
            user = UserStore(db).find_by_username(username)
            if user is None:
                return jsonify({"error": "User not found"}), 404
            doc_store.share_document(uuid, user["id"], permission)
        else:
            doc_store.set_public(uuid, True)

        return jsonify({"status": "shared"}), 201

    @app.route("/api/documents/<uuid>/share", methods=["DELETE"])
    @require_auth
    def remove_share(uuid):
        if not request.is_json:
            return jsonify({"error": "Content-Type must be application/json"}), 400
        data = request.get_json()
        db = get_db()
        doc_store = DocumentStore(db)
        doc = doc_store.retrieve(uuid)
        if doc is None:
            return jsonify({"error": "Document not found"}), 404

        username = data.get("username")
        if username:
            user = UserStore(db).find_by_username(username)
            if user is None:
                return jsonify({"error": "User not found"}), 404
            if doc["owner_id"] != g.current_user["id"] and g.current_user["username"] != username:
                return jsonify({"error": "Forbidden"}), 403
            doc_store.unshare_document(uuid, user["id"])
        else:
            if doc["owner_id"] == g.current_user["id"]:
                doc_store.set_public(uuid, False)
            else:
                doc_store.unshare_document(uuid, g.current_user["id"])

        return jsonify({"status": "unshared"}), 200

    @app.route("/api/documents/<uuid>/shares", methods=["GET"])
    @require_auth
    def list_shares(uuid):
        db = get_db()
        doc_store = DocumentStore(db)
        doc = doc_store.retrieve(uuid)
        if doc is None:
            return jsonify({"error": "Document not found"}), 404
        if doc["owner_id"] != g.current_user["id"]:
            return jsonify({"error": "Forbidden"}), 403
        shares = doc_store.get_shares(uuid)
        return jsonify({"shares": shares})

    @app.route("/api/documents/<uuid>/export", methods=["GET"])
    @require_auth
    def export_document(uuid):
        doc_store = DocumentStore(get_db())
        doc = doc_store.retrieve(uuid)
        if doc is None:
            return jsonify({"error": "Document not found"}), 404
        if not doc_store.has_permission(uuid, g.current_user["id"], "view"):
            return jsonify({"error": "Forbidden"}), 403
        return jsonify({"name": doc["name"], "content": doc["content"]})

    @app.route("/api/documents/<uuid>/thumbnail", methods=["GET"])
    @require_auth
    def get_thumbnail(uuid):
        doc_store = DocumentStore(get_db())
        doc = doc_store.retrieve(uuid)
        if doc is None:
            return jsonify({"error": "Document not found"}), 404
        if not doc_store.has_permission(uuid, g.current_user["id"], "view"):
            return jsonify({"error": "Forbidden"}), 403
        if not doc["preview_image"]:
            return "", 404
        from flask import Response
        return Response(doc["preview_image"], mimetype="image/png")

    @app.route("/api/documents/import", methods=["POST"])
    @require_auth
    def import_document():
        if not request.is_json:
            return jsonify({"error": "Content-Type must be application/json"}), 400
        data = request.get_json()
        name = (data.get("name") or "").strip()
        content = data.get("content") or ""
        if not name:
            return jsonify({"error": "Document name required"}), 400
        uuid = DocumentStore(get_db()).create(name, g.current_user["id"])
        DocumentStore(get_db()).store_content(uuid, content)
        return jsonify({"uuid": uuid, "name": name}), 201

    # ── Upload ───────────────────────────────────────────────────────────────────────

    @app.route("/api/upload", methods=["POST"])
    def upload_file():
        """Accept a STEP/IGES file, store it, return a file_id."""
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        if "file" not in request.files:
            return jsonify({"error": "no file field"}), 400
        f = request.files["file"]
        ext = os.path.splitext(secure_filename(f.filename or ""))[1].lower()
        if ext not in ALLOWED_EXTENSIONS:
            return jsonify({"error": f"unsupported extension {ext!r}"}), 400
        file_id = str(uuid.uuid4()) + ext
        assert "/" not in file_id and "\\" not in file_id
        f.save(os.path.join(UPLOAD_DIR, file_id))
        return jsonify({"file_id": file_id})

    @app.route("/api/export/step", methods=["POST"])
    def export_step():
        """Export bodies to a STEP file and return it as a download.

        Optional request field:
          - body_id: when provided, export only that body
        """
        data = request.get_json(silent=True)
        if not data or "features" not in data:
            return jsonify({"error": "features required"}), 400

        from oversolved.builder import build

        build_result = build(data)

        body_shapes = build_result.get("_body_shapes", {})
        if not body_shapes:
            return jsonify({"error": "no bodies to export"}), 400

        from oversolved.geometry import shape_to_step_file_buffer, fuse_shapes
        body_id = (data.get("body_id") or "").strip() if isinstance(data, dict) else ""

        if body_id:
            shape = body_shapes.get(body_id)
            if shape is None:
                return jsonify({"error": f"body {body_id!r} not found"}), 400
            buffer = shape_to_step_file_buffer(shape)
        elif len(body_shapes) == 1:
            shape = list(body_shapes.values())[0]
            buffer = shape_to_step_file_buffer(shape)
        else:
            shapes = list(body_shapes.values())
            fused = fuse_shapes(shapes)
            buffer = shape_to_step_file_buffer(fused)

        return Response(
            buffer.getvalue(),
            mimetype="application/step",
            headers={"Content-Disposition": "attachment; filename=export.step"},
        )

    @app.route("/api/export/stl", methods=["POST"])
    def export_stl():
        """Export bodies to an STL file and return it as a download.

        Optional request field:
          - body_id: when provided, export only that body
        """
        data = request.get_json(silent=True)
        if not data or "features" not in data:
            return jsonify({"error": "features required"}), 400

        from oversolved.builder import build

        build_result = build(data)

        body_shapes = build_result.get("_body_shapes", {})
        if not body_shapes:
            return jsonify({"error": "no bodies to export"}), 400

        from oversolved.geometry import shape_to_stl_file_buffer, fuse_shapes

        deflection = data.get("deflection", 0.5)
        angular_deflection = data.get("angular_deflection", 0.3)
        body_id = (data.get("body_id") or "").strip() if isinstance(data, dict) else ""

        if body_id:
            shape = body_shapes.get(body_id)
            if shape is None:
                return jsonify({"error": f"body {body_id!r} not found"}), 400
            buffer = shape_to_stl_file_buffer(shape, deflection, angular_deflection)
        elif len(body_shapes) == 1:
            shape = list(body_shapes.values())[0]
            buffer = shape_to_stl_file_buffer(shape, deflection, angular_deflection)
        else:
            shapes = list(body_shapes.values())
            fused = fuse_shapes(shapes)
            buffer = shape_to_stl_file_buffer(fused, deflection, angular_deflection)

        return Response(
            buffer.getvalue(),
            mimetype="application/sla",
            headers={"Content-Disposition": "attachment; filename=export.stl"},
        )

    # ── Solver ─────────────────────────────────────────────────────────────────

    from oversolved.solver_queue import get_document_solver
    from oversolved.cache import TtlCache, L2Cache
    from oversolved.types3d import BuildState

    # Keyed by document id. Not persisted; clears on server restart (full rebuild on restart).
    _build_state_cache: TtlCache[BuildState] = TtlCache(ttl_seconds=300.0, max_size=1000)
    _l2_cache: L2Cache = L2Cache(
        ttl_seconds=app.config["L2_CACHE_TTL"],
        max_size=app.config["L2_CACHE_MAX_SIZE"],
        cache_dir=app.config["L2_CACHE_DIR"],
    )

    @app.route("/api/solve", methods=["POST"])
    def solve_document() -> Response | tuple:
        data = request.get_json(silent=True)
        if not data or "features" not in data:
            return jsonify({"error": "features required"}), 400

        from oversolved.builder import build

        doc_id = data.get("id")
        rollback_position = data.get("rollback_position")
        pick_boundary = data.get("pick_boundary")

        # Use the document-specific cache for prev_state.  The frontend no longer
        # sends prev_state (shapes cannot be serialised over JSON), so the cache
        # is the only viable source of geometric state.
        prev_state: BuildState | None = None
        if doc_id:
            prev_state = _build_state_cache.get(doc_id)
            if prev_state is None and app.config.get("L2_CACHE_ENABLED"):
                prev_state = _l2_cache.get(doc_id)
                if prev_state is not None:
                    _build_state_cache.set(doc_id, prev_state)

        solver = get_document_solver()

        # Serialize ALL solves per document so that concurrent requests (previews,
        # full rebuilds, rollback changes) never race on the cache.
        if doc_id:
            counter = solver.acquire(doc_id)
            try:
                build_result = build(
                    data,
                    prev_state=prev_state,
                    pick_boundary=pick_boundary,
                    rollback_position=rollback_position,
                )
                new_state = build_result.pop("_build_state")
                _build_state_cache.set(doc_id, new_state)
                if app.config.get("L2_CACHE_ENABLED"):
                    _l2_cache.set(doc_id, new_state)
                solver.release(doc_id, counter, build_result)
                build_result.pop("_body_shapes", None)
                return Response(json.dumps(build_result), mimetype="application/json")
            except Exception:
                solver.release(doc_id, counter, {})
                raise
        else:
            build_result = build(
                data,
                prev_state=prev_state,
                pick_boundary=pick_boundary,
                rollback_position=rollback_position,
            )
            build_result.pop("_build_state", None)
            build_result.pop("_body_shapes", None)
            return Response(json.dumps(build_result), mimetype="application/json")

    @app.route("/api/cache/flush", methods=["POST"])
    @require_auth
    @require_admin
    def flush_cache() -> Response | tuple:
        data = request.get_json(silent=True) or {}
        doc_id = data.get("doc_id", "").strip()
        level = data.get("level", "all")

        if not doc_id:
            return jsonify({"error": "doc_id required"}), 400

        if level in ("l1", "all"):
            _build_state_cache.delete(doc_id)

        if level in ("l2", "all") and app.config.get("L2_CACHE_ENABLED"):
            _l2_cache.delete(doc_id)

        return jsonify({"status": "flushed", "doc_id": doc_id, "level": level})

    def _estimate_shape_size(shape) -> int:
        """Estimate serialized size of an OCC shape in bytes."""
        try:
            from oversolved.geometry import shape_to_step_file_buffer
            buf = shape_to_step_file_buffer(shape)
            return len(buf.getvalue())
        except Exception:
            return 0

    @app.route("/api/cache/inspect", methods=["GET"])
    @require_auth
    @require_admin
    def inspect_cache() -> Response | tuple:
        """Return cache inventory for debug inspector."""
        l1_entries = []
        for doc_id, (state, accessed_time) in _build_state_cache._data.items():
            shape_size_estimate = 0
            for checkpoint in state.checkpoints.values():
                for body in checkpoint.body_store_snapshot.values():
                    if body.shape is not None:
                        shape_size_estimate += _estimate_shape_size(body.shape)
            l1_entries.append({
                "doc_id": doc_id,
                "feature_order": state.feature_order,
                "checkpoint_count": len(state.checkpoints),
                "accessed_at": datetime.fromtimestamp(accessed_time).isoformat(),
                "shape_size_estimate": shape_size_estimate,
            })

        l2_entries = []
        if app.config.get("L2_CACHE_ENABLED"):
            cache_dir = Path(_l2_cache._cache_dir)
            if cache_dir.exists():
                for file_path in cache_dir.glob("*.json"):
                    doc_id = file_path.stem
                    stat = file_path.stat()
                    try:
                        with open(file_path, encoding="utf-8") as f:
                            data = json.load(f)
                        checkpoint_count = len(data.get("checkpoints", {}))
                    except Exception:
                        checkpoint_count = 0
                    l2_entries.append({
                        "doc_id": doc_id,
                        "file_path": str(file_path),
                        "file_size": stat.st_size,
                        "created_at": datetime.fromtimestamp(stat.st_ctime).isoformat(),
                        "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                        "checkpoint_count": checkpoint_count,
                    })

        return jsonify({"l1": l1_entries, "l2": l2_entries})

    @app.route("/api/cache/inspect/l2/<doc_id>", methods=["GET"])
    @require_auth
    @require_admin
    def inspect_l2_entry(doc_id: str) -> Response | tuple:
        """Return prettified L2 cache JSON for preview."""
        if not app.config.get("L2_CACHE_ENABLED"):
            return jsonify({"error": "L2 cache not enabled"}), 400

        file_path = Path(_l2_cache._cache_dir) / f"{doc_id}.json"
        if not file_path.exists():
            return jsonify({"error": f"Entry not found: {doc_id}"}), 404

        with open(file_path, encoding="utf-8") as f:
            data = json.load(f)

        json_str = json.dumps(data, indent=2)
        return Response(json_str[:50000], mimetype="application/json")

    @app.route("/api/cache/download/<doc_id>", methods=["GET"])
    @require_auth
    @require_admin
    def download_l2_entry(doc_id: str) -> Response | tuple:
        """Download full L2 cache entry as JSON file."""
        if not app.config.get("L2_CACHE_ENABLED"):
            return jsonify({"error": "L2 cache not enabled"}), 400

        file_path = Path(_l2_cache._cache_dir) / f"{doc_id}.json"
        if not file_path.exists():
            return jsonify({"error": f"Entry not found: {doc_id}"}), 404

        return send_file(
            file_path,
            as_attachment=True,
            download_name=f"{doc_id}_cache.json",
        )

    def _format_history(history):
        """Format edit history for bug report."""
        if not history:
            return "*(no history)*"
        lines = []
        for idx, item in enumerate(history):
            label = item.get("label", "(unknown)")
            lines.append(f"- [{idx}] {label}")
        return "\n".join(lines)

    @app.route("/api/bug-report", methods=["POST"])
    @require_auth
    @require_admin
    def submit_bug_report():
        content_type = request.content_type or ""
        if "application/json" not in content_type:
            return jsonify({"error": "Content-Type must be application/json"}), 400
        data = request.get_json()
        if not data:
            return jsonify({"error": "Empty request body"}), 400
        title = (data.get("title") or "").strip()
        description = (data.get("description") or "").strip()
        if not title or not description:
            return jsonify({"error": "Title and description are required"}), 400

        bugreports_dir = Path(__file__).parent.parent / "bugreports"
        bugreports_dir.mkdir(exist_ok=True)

        safe_title = re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_")[:50]
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{safe_title}_{timestamp}.md"
        filepath = bugreports_dir / filename

        ast_yaml = (
            yaml.dump(data.get("ast"), default_flow_style=False)
            if data.get("ast")
            else "N/A"
        )
        selection = data.get("selection") or []
        solve_results = data.get("solveResults")
        internal_state = data.get("internalState") or {}
        history = data.get("history") or []
        history_section = _format_history(history)

        markdown = f"""# Bug Report: {title}

**Timestamp:** {datetime.now().isoformat()}

## Description

{description}

## Internal State

- **Mode:** {internal_state.get("mode", "N/A")}
- **Active Tool:** {internal_state.get("activeTool", "N/A")}
- **Editing Feature:** {internal_state.get("editingFeatureId", "N/A")}
- **Active Sketch:** {internal_state.get("activeSketchFeatureId", "N/A")}

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

## Edit History

{history_section}

---

*Report generated by Oversolved bug reporter*
"""

        try:
            filepath.write_text(markdown, encoding="utf-8")
            return jsonify({"status": "saved", "filename": filename}), 201
        except Exception as e:
            return jsonify({"error": f"Failed to save report: {e}"}), 500

    # ── Documentation ──────────────────────────────────────────────────────────

    @app.route("/api/docs", methods=["GET"])
    def list_docs():
        docs_path = Path(__file__).parent.parent / "docs"
        if not docs_path.exists():
            return jsonify({"docs": []})
        md_files = sorted([f.stem for f in docs_path.glob("*.md")])
        return jsonify({"docs": md_files})

    @app.route("/api/docs/<doc_name>", methods=["GET"])
    def get_doc(doc_name):
        docs_path = Path(__file__).parent.parent / "docs"
        file_path = docs_path / f"{doc_name}.md"
        try:
            file_path = file_path.resolve()
            docs_path = docs_path.resolve()
            if not str(file_path).startswith(str(docs_path)):
                return jsonify({"error": "Invalid doc name"}), 400
        except (OSError, ValueError):
            return jsonify({"error": "Invalid doc name"}), 400
        if not file_path.exists():
            return jsonify({"error": "Documentation not found"}), 404
        try:
            content = file_path.read_text(encoding="utf-8")
            return jsonify({"name": doc_name, "content": content})
        except OSError:
            return jsonify({"error": "Failed to read documentation"}), 500

    # ── Frontend ───────────────────────────────────────────────────────────────

    frontend_dist = Path(__file__).parent.parent / "frontend" / "dist"
    if frontend_dist.exists():

        @app.route("/")
        @app.route("/<path:path>")
        def serve_frontend(path="index.html"):
            if path and (frontend_dist / path).exists():
                return send_from_directory(frontend_dist, path)
            return send_from_directory(frontend_dist, "index.html")

    @app.teardown_appcontext
    def close_db(error):
        db = g.pop("db", None)
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

    db.register_migration(1, "initial_schema", migration_001_initial_schema)

    def migration_002_add_preview_image(database: Database):
        """Add preview_image column to documents table."""
        database.execute("ALTER TABLE documents ADD COLUMN preview_image BLOB")

    db.register_migration(2, "add_preview_image", migration_002_add_preview_image)

    def migration_003_add_shares(database: Database):
        """Add document_shares table and is_public column."""
        database.execute("""
            CREATE TABLE document_shares (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_uuid TEXT NOT NULL,
                shared_with_user_id INTEGER NULL,
                permission TEXT NOT NULL DEFAULT 'view',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (document_uuid) REFERENCES documents(uuid) ON DELETE CASCADE,
                FOREIGN KEY (shared_with_user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(document_uuid, shared_with_user_id)
            )
        """)
        database.execute("ALTER TABLE documents ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0")

    db.register_migration(3, "add_shares", migration_003_add_shares)

    def migration_004_add_user_management_fields(database: Database):
        """Add is_admin and is_active columns to users table."""
        database.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")
        database.execute("ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1")

    db.register_migration(4, "add_user_management_fields", migration_004_add_user_management_fields)

    def migration_005_add_last_login(database: Database):
        """Add last_login_at column to users table."""
        database.execute("ALTER TABLE users ADD COLUMN last_login_at TEXT")

    db.register_migration(5, "add_last_login", migration_005_add_last_login)

    def _column_exists(database: Database, table: str, column: str) -> bool:
        """Check if a column already exists in a table."""
        cursor = database.execute(f"PRAGMA table_info({table})")
        return any(row[1] == column for row in cursor.fetchall())

    def migration_006_user_oauth_prep(database: Database):
        """Add email, nickname, OAuth fields to users table."""
        if not _column_exists(database, "users", "email"):
            database.execute("ALTER TABLE users ADD COLUMN email TEXT")
        if not _column_exists(database, "users", "nickname"):
            database.execute("ALTER TABLE users ADD COLUMN nickname TEXT")
        if not _column_exists(database, "users", "external_id"):
            database.execute("ALTER TABLE users ADD COLUMN external_id TEXT")
        if not _column_exists(database, "users", "provider"):
            database.execute("ALTER TABLE users ADD COLUMN provider TEXT")
        if not _column_exists(database, "users", "provider_data"):
            database.execute("ALTER TABLE users ADD COLUMN provider_data TEXT")
        if not _column_exists(database, "users", "updated_at"):
            database.execute("ALTER TABLE users ADD COLUMN updated_at TEXT")
        # Backfill missing fields for existing users
        database.execute(
            "UPDATE users SET updated_at = datetime('now') WHERE updated_at IS NULL"
        )
        database.execute(
            "UPDATE users SET email = username || '@local.oversolved' WHERE email IS NULL"
        )
        # Create unique indices
        database.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)"
        )
        database.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nickname ON users(nickname)"
        )
        database.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS "
            "idx_users_external_id_provider ON users(external_id, provider)"
        )

    db.register_migration(6, "user_oauth_prep", migration_006_user_oauth_prep)

    def migration_007_user_sort_preference(database: Database):
        """Add document_sort_preference column to users table."""
        if not _column_exists(database, "users", "document_sort_preference"):
            database.execute(
                "ALTER TABLE users ADD COLUMN document_sort_preference TEXT DEFAULT 'alphabetical'"
            )

    db.register_migration(7, "user_sort_preference", migration_007_user_sort_preference)

    def migration_008_organizations(database: Database):
        """Organizations feature removed - this migration is no-op for existing dbs."""
        pass

    db.register_migration(8, "organizations", migration_008_organizations)

    def migration_009_documents_org_id(database: Database):
        """Organization documents feature removed - this migration is no-op for existing dbs."""
        pass

    db.register_migration(9, "documents_org_id", migration_009_documents_org_id)

    def migration_010_document_trash(database: Database):
        """Add deleted_at column to documents for soft delete."""
        if not _column_exists(database, "documents", "deleted_at"):
            database.execute("ALTER TABLE documents ADD COLUMN deleted_at TEXT")
        database.execute("CREATE INDEX IF NOT EXISTS idx_documents_deleted_at ON documents(deleted_at)")

    db.register_migration(10, "document_trash", migration_010_document_trash)

    def migration_011_periodic_tasks(database: Database):
        """Create periodic_tasks table for tracking system task execution."""
        database.execute("""
            CREATE TABLE IF NOT EXISTS periodic_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_key TEXT UNIQUE NOT NULL,
                last_run_at TEXT,
                last_run_status TEXT
            )
        """)

    db.register_migration(11, "periodic_tasks", migration_011_periodic_tasks)

    def migration_012_accounts_table(database: Database):
        """Create unified accounts table for user namespace tracking."""
        database.execute("""
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                handle TEXT UNIQUE NOT NULL,
                owner_type TEXT NOT NULL,
                owner_id INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        database.execute("""
            CREATE INDEX IF NOT EXISTS idx_accounts_handle ON accounts(handle)
        """)
        database.execute("""
            CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner_type, owner_id)
        """)

        cursor = database.execute("SELECT id, username FROM users WHERE username IS NOT NULL")
        for row in cursor.fetchall():
            uid, username = row[0], row[1]
            database.execute(
                """INSERT OR IGNORE INTO accounts (handle, owner_type, owner_id)
                   VALUES (?, ?, ?)""",
                (username, "user", uid),
            )

    db.register_migration(12, "accounts_table", migration_012_accounts_table)

    def migration_013_remove_nickname(database: Database):
        """Remove nickname column and index from users table."""
        if _column_exists(database, "users", "nickname"):
            database.execute("DROP INDEX IF EXISTS idx_users_nickname")
            database.execute("ALTER TABLE users DROP COLUMN nickname")

    db.register_migration(13, "remove_nickname", migration_013_remove_nickname)

    def migration_014_remove_organizations(database: Database):
        """Remove organization support - drop org tables and org_id column."""
        database.execute("DROP TABLE IF EXISTS organization_members")
        database.execute("DROP TABLE IF EXISTS organizations")
        if _column_exists(database, "documents", "org_id"):
            database.execute("ALTER TABLE documents DROP COLUMN org_id")

    db.register_migration(14, "remove_organizations", migration_014_remove_organizations)


if __name__ == "__main__":
    app = create_app()
    app.run(debug=True)
