"""Admin routes: users, periodic-tasks, backup, import-backup, bug-report."""

import logging
import os
import re
import tempfile
import yaml
import zipfile
from pathlib import Path
from datetime import datetime, timezone
from typing import Any, Iterator
from flask import Blueprint, jsonify, request, send_file
from flask.typing import ResponseReturnValue
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash
from oversolved.db import Database, DocumentStore, UserStore, PeriodicTaskStore
from flask import g
from oversolved.blueprints import require_auth, require_admin, require_csrf, get_db, validate_password_strength, api_error

logger = logging.getLogger(__name__)

admin_bp = Blueprint("admin", __name__)


def _format_history(history: list[dict]) -> str:
    """Format edit history list for bug report markdown."""
    if not history:
        return "*(no history)*"
    lines = []
    for idx, item in enumerate(history):
        label = item.get("label", "(unknown)")
        lines.append(f"- [{idx}] {label}")
    return "\n".join(lines)


# ── Admin Users ────────────────────────────────────────────────────────────


@admin_bp.route("/api/admin/users", methods=["GET"])
@require_auth
@require_csrf
@require_admin
def list_users() -> ResponseReturnValue:
    users = UserStore(get_db()).list_all()
    return jsonify({"users": users})


@admin_bp.route("/api/admin/users", methods=["POST"])
@require_auth
@require_csrf
@require_admin
def create_user_admin() -> ResponseReturnValue:
    if not request.is_json:
        return api_error("Content-Type must be application/json", "INVALID_CONTENT_TYPE", 400)
    data = request.get_json()
    username = (data.get("username") or "").strip()
    email = (data.get("email") or "").strip()
    password = data.get("password") or ""
    is_admin = bool(data.get("is_admin", False))

    if not username or not password:
        return api_error("Username and password required", "BAD_REQUEST", 400)
    if not email:
        return api_error("Email required", "BAD_REQUEST", 400)

    pw_error = validate_password_strength(password)
    if pw_error:
        return api_error(pw_error, "VALIDATION_ERROR", 400)

    db = get_db()
    user_store = UserStore(db)
    if user_store.find_by_username(username):
        return api_error("Username already exists", "CONFLICT", 409)
    if user_store.find_by_email(email):
        return api_error("Email already exists", "CONFLICT", 409)

    uid = user_store.create(
        username, generate_password_hash(password),
        email=email,
        is_admin=is_admin,
    )
    return jsonify({"id": uid, "username": username, "email": email}), 201


@admin_bp.route("/api/admin/users/<int:user_id>", methods=["PUT"])
@require_auth
@require_csrf
@require_admin
def admin_update_user(user_id: int) -> ResponseReturnValue:
    if not request.is_json:
        return api_error("Content-Type must be application/json", "INVALID_CONTENT_TYPE", 400)
    data = request.get_json()

    if user_id == g.current_user["id"] and data.get("is_active") is False:
        return api_error("Cannot deactivate yourself", "FORBIDDEN", 403)
    if user_id == g.current_user["id"] and data.get("is_admin") is False:
        return api_error("Cannot remove your own admin privileges", "FORBIDDEN", 403)

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
        return api_error("No fields to update", "BAD_REQUEST", 400)

    success = user_store.update(user_id, **updates)
    if not success:
        return api_error("User not found", "NOT_FOUND", 404)

    return jsonify({"status": "updated"})


@admin_bp.route("/api/admin/users/<int:user_id>", methods=["DELETE"])
@require_auth
@require_csrf
@require_admin
def admin_delete_user(user_id: int) -> ResponseReturnValue:
    if user_id == g.current_user["id"]:
        return api_error("Cannot delete yourself", "FORBIDDEN", 403)

    db = get_db()
    user_store = UserStore(db)
    success = user_store.delete(user_id)
    if not success:
        return api_error("User not found", "NOT_FOUND", 404)
    return jsonify({"status": "deleted"})


@admin_bp.route("/api/admin/users/<int:user_id>/reset", methods=["POST"])
@require_auth
@require_csrf
@require_admin
def admin_reset_password(user_id: int) -> ResponseReturnValue:
    if not request.is_json:
        return api_error("Content-Type must be application/json", "INVALID_CONTENT_TYPE", 400)
    data = request.get_json()
    new_password = data.get("password") or ""
    if not new_password:
        return api_error("Password required", "BAD_REQUEST", 400)

    pw_error = validate_password_strength(new_password)
    if pw_error:
        return api_error(pw_error, "VALIDATION_ERROR", 400)

    db = get_db()
    user_store = UserStore(db)
    success = user_store.change_password(user_id, generate_password_hash(new_password))
    if not success:
        return api_error("User not found", "NOT_FOUND", 404)
    return jsonify({"status": "reset"})


# ── Admin Periodic Tasks ───────────────────────────────────────────────────


@admin_bp.route("/api/admin/periodic-tasks", methods=["GET"])
@require_auth
@require_csrf
@require_admin
def list_periodic_tasks() -> ResponseReturnValue:
    task_store = PeriodicTaskStore(get_db())
    tasks = task_store.find_all()
    return jsonify({"tasks": tasks})


@admin_bp.route("/api/admin/periodic-tasks/<task_key>/run", methods=["POST"])
@require_auth
@require_csrf
@require_admin
def force_run_periodic_task(task_key: str) -> ResponseReturnValue:
    from oversolved.periodic_tasks import TaskScheduler, EmptyTrashTask

    db = get_db()
    scheduler = TaskScheduler()
    scheduler.register_task(EmptyTrashTask())
    result = scheduler.force_run_task(task_key, db)
    return jsonify(result)


# ── Admin Backup ───────────────────────────────────────────────────────────


def _iter_documents_page(db: Database, page_size: int = 100) -> Iterator[Any]:
    """Yield documents in pages to avoid loading all into memory."""
    offset = 0
    while True:
        cursor = db.execute(
            "SELECT uuid, name, content, preview_image, owner_id FROM documents "
            "WHERE deleted_at IS NULL ORDER BY owner_id, name "
            "LIMIT ? OFFSET ?",
            (page_size, offset),
        )
        rows = cursor.fetchall()
        if not rows:
            break
        for row in rows:
            yield row
        offset += page_size


@admin_bp.route("/api/admin/backup", methods=["GET"])
@require_auth
@require_csrf
@require_admin
def backup_all_documents() -> ResponseReturnValue:
    db = get_db()
    user_store = UserStore(db)
    file_counts: dict[tuple[str, str], int] = {}
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
    try:
        with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zip_file:
            for doc_uuid, name, content, preview_image, owner_id in _iter_documents_page(db):
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

        tmp.close()
        return send_file(
            tmp.name,
            mimetype='application/zip',
            as_attachment=True,
            download_name=f'oversolved-backup-{datetime.now(timezone.utc).strftime("%Y-%m-%d")}.zip'
        )
    finally:
        if os.path.exists(tmp.name):
            os.unlink(tmp.name)


@admin_bp.route("/api/admin/import-backup", methods=["POST"])
@require_auth
@require_csrf
@require_admin
def import_backup() -> ResponseReturnValue:
    if "file" not in request.files:
        return api_error("No file provided", "BAD_REQUEST", 400)

    file = request.files["file"]
    if not file.filename or not file.filename.endswith('.zip'):
        return api_error("File must be a zip file", "BAD_REQUEST", 400)

    # Best-effort compressed-size pre-check (None under chunked encoding).
    MAX_IMPORT_FILE_SIZE = 100 * 1024 * 1024
    compressed_size = request.content_length
    if compressed_size is not None and compressed_size > MAX_IMPORT_FILE_SIZE:
        return api_error("File too large", "CONTENT_TOO_LARGE", 413)

    try:
        MAX_ZIP_ENTRIES = 10000
        MAX_ZIP_DECOMPRESSED = 500 * 1024 * 1024

        with zipfile.ZipFile(file.stream, 'r') as bomb_check:
            if len(bomb_check.filelist) > MAX_ZIP_ENTRIES:
                return api_error("Archive contains too many files", "BAD_REQUEST", 400)
            total_decompressed = 0
            for file_info in bomb_check.filelist:
                total_decompressed += file_info.file_size
                if total_decompressed > MAX_ZIP_DECOMPRESSED:
                    return api_error("Archive too large when decompressed", "BAD_REQUEST", 400)
        file.stream.seek(0)

        db = get_db()
        user_store = UserStore(db)
        doc_store = DocumentStore(db)

        imported_count = 0
        skipped_count = 0
        errors = []

        with zipfile.ZipFile(file.stream, 'r') as zip_file:
            files_by_user: dict[str, dict[str, str]] = {}
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
                        logger.warning("Import failed for %s: %s", yaml_name, e, exc_info=True)
                        errors.append(f"Import failed for {yaml_name}")

        return jsonify({
            "status": "imported",
            "imported_count": imported_count,
            "skipped_count": skipped_count,
            "errors": errors if errors else None
        }), 200

    except OSError:
        return api_error("Failed to read uploaded file", "BAD_REQUEST", 400)
    except zipfile.BadZipFile:
        return api_error("Invalid zip file", "BAD_REQUEST", 400)
    except Exception as e:
        return api_error(f"Import failed: {str(e)}", "INTERNAL_SERVER_ERROR", 500)


# ── Bug Report ─────────────────────────────────────────────────────────────


@admin_bp.route("/api/bug-report", methods=["POST"])
@require_auth
@require_csrf
@require_admin
def submit_bug_report() -> ResponseReturnValue:
    content_type = request.content_type or ""
    if "application/json" not in content_type:
        return api_error("Content-Type must be application/json", "INVALID_CONTENT_TYPE", 400)
    data = request.get_json()
    if not data:
        return api_error("Empty request body", "BAD_REQUEST", 400)
    title = (data.get("title") or "").strip()
    description = (data.get("description") or "").strip()
    if not title:
        return api_error("Title is required", "BAD_REQUEST", 400)

    bugreports_dir = Path(__file__).parent.parent.parent / "bugreports"
    bugreports_dir.mkdir(exist_ok=True)

    safe_title = re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_")[:50]
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    filename = f"{safe_title}_{timestamp}.md"
    filepath = bugreports_dir / filename

    ast_yaml = (
        yaml.dump(data.get("ast"), default_flow_style=False)
        if data.get("ast")
        else "N/A"
    )
    selection = data.get("selection") or []
    history = data.get("history") or []
    history_section = _format_history(history)

    markdown = f"""# Bug Report: {title}

## Description

{description}

## Selection

{f"**{len(selection)} item(s) selected:**" if selection else "**No selection**"}

```
{chr(10).join(selection) if selection else "(empty)"}
```

## AST (Document)

```yaml
{ast_yaml}
```

## Edit History

{history_section}

---

*Report generated by Oversolved bug reporter*
"""

    try:
        filepath.write_text(markdown, encoding="utf-8")
        return jsonify({"status": "saved", "filename": filename}), 201
    except Exception as e:
        return api_error(f"Failed to save report: {e}", "INTERNAL_SERVER_ERROR", 500)
