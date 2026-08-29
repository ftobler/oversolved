"""Admin routes: users, periodic-tasks, backup, import-backup, bug-report."""

import logging
import os
import re
import tempfile
import unicodedata
import yaml
import zipfile
from pathlib import Path
from datetime import datetime, timezone
from typing import Any, Iterator
from flask import Blueprint, jsonify, request, send_file
from flask.typing import ResponseReturnValue
from werkzeug.security import generate_password_hash
from oversolved.db import Database, DocumentStore, PeriodicTaskStore, SessionStore, UserStore
from flask import g
from oversolved.auth import AuthOk, authenticate_token
from oversolved.blueprints import (
    auth_required, get_db, require_csrf, require_json, validate_password_strength, api_error,
    integrity_error_types,
)
from oversolved.blueprints.documents import decode_png
from oversolved.rate_limit import RateLimiter

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


# ─── Admin Users ───


@admin_bp.route("/api/admin/users", methods=["GET"])
@auth_required(admin=True)
def list_users() -> ResponseReturnValue:
    users = UserStore(get_db()).list_all()
    return jsonify({"users": users})


@admin_bp.route("/api/admin/users", methods=["POST"])
@auth_required(admin=True, json=True)
def create_user_admin() -> ResponseReturnValue:
    data = request.get_json()
    # Non-string scalars would crash .strip(); reject them as client errors.
    if data.get("username") is not None and not isinstance(data.get("username"), str):
        return api_error("Username must be a string", "BAD_REQUEST", 400)
    if data.get("email") is not None and not isinstance(data.get("email"), str):
        return api_error("Email must be a string", "BAD_REQUEST", 400)
    # A non-string password would crash len() inside validate_password_strength.
    if data.get("password") is not None and not isinstance(data.get("password"), str):
        return api_error("Password must be a string", "BAD_REQUEST", 400)
    username = (data.get("username") or "").strip()
    email = (data.get("email") or "").strip()
    password = data.get("password") or ""
    # A JSON boolean is the only accepted value. bool("false") and bool(0) are
    # both True, so coercing a string/number here would silently grant admin.
    is_admin_raw = data.get("is_admin", False)
    if not isinstance(is_admin_raw, bool):
        return api_error("is_admin must be a boolean", "BAD_REQUEST", 400)
    is_admin = is_admin_raw

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

    try:
        uid = user_store.create(
            username, generate_password_hash(password),
            email=email,
            is_admin=is_admin,
        )
    except integrity_error_types():
        # Lost a race with the pre-check above: another request claimed this
        # username or email first. Answer 409 rather than surfacing the unique
        # constraint as a 500.
        return api_error("Username or email already exists", "CONFLICT", 409)
    return jsonify({"id": uid, "username": username, "email": email}), 201


@admin_bp.route("/api/admin/users/<int:user_id>", methods=["PUT"])
@auth_required(admin=True, json=True)
def admin_update_user(user_id: int) -> ResponseReturnValue:
    data = request.get_json()

    if user_id == g.current_user["id"] and data.get("is_active") is False:
        return api_error("Cannot deactivate yourself", "FORBIDDEN", 403)
    if user_id == g.current_user["id"] and data.get("is_admin") is False:
        return api_error("Cannot remove your own admin privileges", "FORBIDDEN", 403)

    db = get_db()
    user_store = UserStore(db)

    # Annotated because the isinstance guards below narrow the field types and
    # mypy would otherwise pin the value type from the first write.
    updates: dict[str, Any] = {}
    if "username" in data:
        # A non-string scalar such as a number would crash .strip().
        if data["username"] is not None and not isinstance(data["username"], str):
            return api_error("Username must be a string", "BAD_REQUEST", 400)
        # username is NOT NULL, so a null or blank value is a client error, not a wipe.
        new_username = (data["username"] or "").strip()
        if not new_username:
            return api_error("Username cannot be empty", "BAD_REQUEST", 400)
        # Pre-check so a taken name answers 409 like create_user_admin instead of
        # bubbling the unique-constraint IntegrityError out as a 500.
        existing = user_store.find_by_username(new_username)
        if existing is not None and existing["id"] != user_id:
            return api_error("Username already exists", "CONFLICT", 409)
        updates["username"] = new_username
    if "email" in data:
        if data["email"] is not None and not isinstance(data["email"], str):
            # A non-string scalar such as a number would crash .strip().
            return api_error("Email must be a string", "BAD_REQUEST", 400)
        new_email = data["email"].strip() if data["email"] else None
        # Pre-check so a taken address answers 409 like create_user_admin instead of
        # bubbling the unique-constraint IntegrityError out as a 500.
        if new_email:
            existing = user_store.find_by_email(new_email)
            if existing is not None and existing["id"] != user_id:
                return api_error("Email already exists", "CONFLICT", 409)
        updates["email"] = new_email
    if "is_active" in data:
        is_active_raw = data["is_active"]
        if not isinstance(is_active_raw, bool):
            return api_error("is_active must be a boolean", "BAD_REQUEST", 400)
        updates["is_active"] = 1 if is_active_raw else 0
    if "is_admin" in data:
        is_admin_raw = data["is_admin"]
        if not isinstance(is_admin_raw, bool):
            return api_error("is_admin must be a boolean", "BAD_REQUEST", 400)
        updates["is_admin"] = 1 if is_admin_raw else 0

    if not updates:
        return api_error("No fields to update", "BAD_REQUEST", 400)

    try:
        success = user_store.update(user_id, **updates)
    except integrity_error_types():
        # Lost a race with the pre-check above: the new username or email was
        # taken by another account between the check and the write.
        return api_error("Username or email already exists", "CONFLICT", 409)
    if not success:
        return api_error("User not found", "NOT_FOUND", 404)

    return jsonify({"status": "updated"})


@admin_bp.route("/api/admin/users/<int:user_id>", methods=["DELETE"])
@auth_required(admin=True)
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
@auth_required(admin=True, json=True)
def admin_reset_password(user_id: int) -> ResponseReturnValue:
    data = request.get_json()
    raw_password = data.get("password")
    # A non-string scalar such as a number would crash len() inside
    # validate_password_strength.
    if raw_password is not None and not isinstance(raw_password, str):
        return api_error("Password must be a string", "BAD_REQUEST", 400)
    new_password = raw_password or ""
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
    # Same rule as the self-service change: outstanding tokens for the target
    # account die with the old password. When an admin resets their own
    # password, keep_token spares the session performing the reset.
    SessionStore(db).revoke_all_for_user(
        user_id, keep_token=request.cookies.get("session_token")
    )
    return jsonify({"status": "reset"})


# ─── Admin Periodic Tasks ───


@admin_bp.route("/api/admin/periodic-tasks", methods=["GET"])
@auth_required(admin=True)
def list_periodic_tasks() -> ResponseReturnValue:
    task_store = PeriodicTaskStore(get_db())
    tasks = task_store.find_all()
    return jsonify({"tasks": tasks})


@admin_bp.route("/api/admin/periodic-tasks/<task_key>/run", methods=["POST"])
@auth_required(admin=True)
def force_run_periodic_task(task_key: str) -> ResponseReturnValue:
    from oversolved.periodic_tasks import TaskScheduler, EmptyTrashTask

    db = get_db()
    scheduler = TaskScheduler()
    scheduler.register_task(EmptyTrashTask())
    result = scheduler.force_run_task(task_key, db)
    return jsonify(result)


# ─── Admin Backup ───


def _safe_component(name: str) -> str:
    """Map a document name to a safe zip member component, keeping unicode.

    secure_filename() transliterates non-ASCII away, so a document named
    "Müller" was silently backed up as "M_ller". We keep the original glyphs but
    strip anything that could climb out of the user's folder (path separators,
    NUL) or is a control character, and refuse a name that collapses to dots.
    """
    if not name:
        return "document"
    cleaned = name.replace("/", "_").replace("\\", "_").replace("\x00", "")
    cleaned = "".join(
        ch for ch in cleaned if ch == " " or unicodedata.category(ch)[0] != "C"
    )
    cleaned = cleaned.strip().strip(".")
    return cleaned or "document"


def _iter_documents_page(db: Database, page_size: int = 100) -> Iterator[Any]:
    """Yield documents in pages to avoid loading all into memory.

    Uses keyset (seek) pagination over the (owner_id, name, uuid) total order
    instead of LIMIT/OFFSET. OFFSET paging shifts under concurrent writes: an
    insert before the current cursor position would either skip a row or repeat
    one, so a backup taken while documents are being created/deleted would be
    incomplete or duplicated. The keyset cursor advances by the last seen key,
    which is stable regardless of rows inserted elsewhere.
    """
    last: tuple[Any, Any, Any] | None = None
    while True:
        if last is None:
            cursor = db.execute(
                "SELECT uuid, name, content, preview_image, owner_id FROM documents "
                "WHERE deleted_at IS NULL ORDER BY owner_id, name, uuid LIMIT ?",
                (page_size,),
            )
        else:
            # (owner_id, name, uuid) is a total order, so a strict tuple
            # comparison continues exactly where the previous page ended.
            cursor = db.execute(
                "SELECT uuid, name, content, preview_image, owner_id FROM documents "
                "WHERE deleted_at IS NULL AND ("
                "owner_id > ? OR (owner_id = ? AND name > ?) "
                "OR (owner_id = ? AND name = ? AND uuid > ?)) "
                "ORDER BY owner_id, name, uuid LIMIT ?",
                (last[0], last[0], last[1], last[0], last[1], last[2], page_size),
            )
        rows = cursor.fetchall()
        if not rows:
            break
        for row in rows:
            yield row
        last = (rows[-1][4], rows[-1][1], rows[-1][0])


@admin_bp.route("/api/admin/backup", methods=["GET"])
@auth_required(admin=True)
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
                doc_name = _safe_component(name)
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


# ─── Import backup (restore) ───

# Zip-bomb guardrails for the import path. The entry count caps pathological
# archives; the decompressed-size cap stops a modest entry count of huge files.
_MAX_ZIP_ENTRIES = 10000
_MAX_ZIP_DECOMPRESSED = 500 * 1024 * 1024


def _check_zip_limits(stream: Any) -> ResponseReturnValue | None:
    """Return an error response if `stream` is a zip-bomb, else None (ok).

    Reads the zip central directory only (no decompression); the caller must
    `seek(0)` afterwards before re-reading for the actual import.
    """
    with zipfile.ZipFile(stream, 'r') as bomb_check:
        if len(bomb_check.filelist) > _MAX_ZIP_ENTRIES:
            return api_error("Archive contains too many files", "BAD_REQUEST", 400)
        total_decompressed = 0
        for file_info in bomb_check.filelist:
            total_decompressed += file_info.file_size
            if total_decompressed > _MAX_ZIP_DECOMPRESSED:
                return api_error("Archive too large when decompressed", "BAD_REQUEST", 400)
    return None


@admin_bp.route("/api/admin/import-backup", methods=["POST"])
@auth_required(admin=True)
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
        bomb_error = _check_zip_limits(file.stream)
        if bomb_error is not None:
            return bomb_error
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
                if len(parts) != 2:
                    # Backups are flat (username/document.yaml); a nested or
                    # single-component path is not a restorable document and
                    # would otherwise be silently flattened into the wrong name.
                    errors.append(f"Invalid path structure: {path}")
                    skipped_count += 1
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

                        png_name = f"{doc_name}.png"
                        preview_data = None
                        if png_name in files:
                            preview_data = zip_file.read(files[png_name])
                            # Same PNG gate as update_document: these bytes are
                            # served as image/png later. Validating before the
                            # insert keeps a bad preview from half-importing
                            # the entry.
                            decode_png(preview_data)

                        # Atomic create+content+preview insert: a mid-import
                        # failure must not leave a committed half-imported entry.
                        doc_store.import_document(
                            doc_name, user["id"], content, preview_image=preview_data
                        )

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


# ─── Bug Report ───

# The header's bug button sits on every page for every visitor, signed-out
# guests included: 27e88e8c promoted the reporter out of the admin-gated F2
# drawer precisely because "any user hits bugs". The endpoint kept the admin
# gate it had inside that drawer, so the button answered 401 to everyone it was
# promoted for. Auth is optional here on purpose; what bounds the abuse an open
# endpoint invites is the same-origin CSRF check plus an IP rate limit, because
# every accepted report writes a file to disk.
_BUG_REPORT_RATE_LIMIT = 5
_BUG_REPORT_RATE_WINDOW = 600

_bug_report_limiter = RateLimiter(
    window_s=_BUG_REPORT_RATE_WINDOW, max_events=_BUG_REPORT_RATE_LIMIT
)


def _reporter_label() -> str:
    """Name the submitter in the report file, without requiring a session."""
    result = authenticate_token(get_db(), request.cookies.get("session_token"))
    if isinstance(result, AuthOk):
        return f"{result.user['username']} <{result.user.get('email') or 'no email'}>"
    return "guest (not signed in)"


@admin_bp.route("/api/bug-report", methods=["POST"])
@require_csrf
@require_json
def submit_bug_report() -> ResponseReturnValue:
    client_ip = request.remote_addr or "unknown"
    if _bug_report_limiter.is_exceeded(client_ip):
        return api_error("Too many bug reports, please try again later", "RATE_LIMITED", 429)

    data = request.get_json()
    if not data:
        return api_error("Empty request body", "BAD_REQUEST", 400)
    # Non-string scalars would crash .strip() below; absent keys keep the
    # optional-title/optional-description semantics.
    if data.get("title") is not None and not isinstance(data.get("title"), str):
        return api_error("Title must be a string", "BAD_REQUEST", 400)
    if data.get("description") is not None and not isinstance(data.get("description"), str):
        return api_error("Description must be a string", "BAD_REQUEST", 400)
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

*Reported by {_reporter_label()}*

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
    except Exception as e:
        return api_error(f"Failed to save report: {e}", "INTERNAL_SERVER_ERROR", 500)
    # Only a report that reached the disk counts against the limit; a rejected
    # body costs nothing to serve and must not lock a real reporter out.
    _bug_report_limiter.record(client_ip)
    return jsonify({"status": "saved", "filename": filename}), 201
