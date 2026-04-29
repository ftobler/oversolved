"""Flask application for the Oversolved solver API."""

import json
import os
import uuid
from functools import wraps
from pathlib import Path
from datetime import datetime
import re
import yaml
from io import BytesIO
from PIL import Image
from flask import (
    Flask,
    Response,
    g,
    jsonify,
    request,
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


def create_app(config: dict | None = None) -> Flask:
    """Create and configure the Flask app."""
    app = Flask(__name__)

    app.config.update(
        {
            "DB_TYPE": "sqlite",
            "DB_PATH": ":memory:",
            "JSON_SORT_KEYS": False,
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
            or user_store.find_by_nickname(credential)
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
                        "nickname": user.get("nickname"),
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
                    "must_change_password": user["must_change_password"],
                    "is_admin": user["is_admin"],
                    "is_active": user["is_active"],
                    "last_login_at": user["last_login_at"],
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

    @app.route("/api/users/me", methods=["GET"])
    @require_auth
    def get_profile():
        return jsonify(
            {
                "user": {
                    "id": g.current_user["id"],
                    "username": g.current_user["username"],
                    "email": g.current_user.get("email"),
                    "nickname": g.current_user.get("nickname"),
                    "must_change_password": g.current_user["must_change_password"],
                    "is_admin": g.current_user["is_admin"],
                    "is_active": g.current_user["is_active"],
                    "created_at": g.current_user.get("created_at"),
                    "last_login_at": g.current_user.get("last_login_at"),
                    "updated_at": g.current_user.get("updated_at"),
                }
            }
        )

    @app.route("/api/users/me", methods=["PUT"])
    @require_auth
    def update_profile():
        if not request.is_json:
            return jsonify({"error": "Content-Type must be application/json"}), 400
        data = request.get_json()
        username = data.get("username")
        email = data.get("email")
        nickname = data.get("nickname")
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

        if nickname is not None:
            updates["nickname"] = nickname.strip() if nickname else None

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
        nickname = data.get("nickname")
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
            nickname=nickname.strip() if nickname else None,
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
        if "nickname" in data:
            updates["nickname"] = data["nickname"].strip() if data["nickname"] else None
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
        uuid = DocumentStore(get_db()).create(name, g.current_user["id"])
        return jsonify({"uuid": uuid, "name": name}), 201

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
        response = {
            "uuid": doc["uuid"],
            "name": doc["name"],
            "content": doc["content"],
            "permission": permission,
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
        doc_store.delete(uuid)
        return jsonify({"uuid": uuid, "status": "deleted"}), 200

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
        if doc["owner_id"] != g.current_user["id"]:
            return jsonify({"error": "Forbidden"}), 403

        username = data.get("username")
        if username:
            user = UserStore(db).find_by_username(username)
            if user is None:
                return jsonify({"error": "User not found"}), 404
            doc_store.unshare_document(uuid, user["id"])
        else:
            doc_store.set_public(uuid, False)

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
    from oversolved.cache import TtlCache
    from oversolved.types3d import BuildState

    # Keyed by document id. Not persisted; clears on server restart (full rebuild on restart).
    _build_state_cache: TtlCache[BuildState] = TtlCache(ttl_seconds=300.0, max_size=1000)

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
                _build_state_cache.set(doc_id, build_result.pop("_build_state"))
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

    def migration_006_user_oauth_prep(database: Database):
        """Add email, nickname, OAuth fields to users table."""
        database.execute("ALTER TABLE users ADD COLUMN email TEXT")
        database.execute("ALTER TABLE users ADD COLUMN nickname TEXT")
        database.execute("ALTER TABLE users ADD COLUMN external_id TEXT")
        database.execute("ALTER TABLE users ADD COLUMN provider TEXT")
        database.execute("ALTER TABLE users ADD COLUMN provider_data TEXT")
        database.execute("ALTER TABLE users ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))")
        # Backfill email from username for existing users
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
        database.execute(
            "ALTER TABLE users ADD COLUMN document_sort_preference TEXT DEFAULT 'alphabetical'"
        )

    db.register_migration(7, "user_sort_preference", migration_007_user_sort_preference)


if __name__ == "__main__":
    app = create_app()
    app.run(debug=True)
