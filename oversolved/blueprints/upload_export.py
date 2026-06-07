"""File upload and STEP/STL export routes."""

import importlib
import os
import uuid
from flask import Blueprint, current_app, jsonify, request, Response
from werkzeug.utils import secure_filename
from oversolved.blueprints import require_auth, require_csrf, api_error

upload_export_bp = Blueprint("upload_export", __name__)

ALLOWED_EXTENSIONS = {".step", ".stp", ".iges", ".igs"}


def get_upload_dir():
    """Return the upload directory from app config or env var fallback."""
    try:
        return current_app.config["OVERSOLVED"].upload_dir
    except RuntimeError:
        return os.environ.get(
            "OVERSOLVED_UPLOAD_DIR",
            os.path.normpath(
                os.path.join(os.path.dirname(__file__), "..", "uploads")
            ),
        )


@upload_export_bp.route("/api/upload", methods=["POST"])
@require_auth
@require_csrf
def upload_file():
    upload_dir = get_upload_dir()
    os.makedirs(upload_dir, exist_ok=True)
    if "file" not in request.files:
        return api_error("no file field", "BAD_REQUEST", 400)
    f = request.files["file"]
    ext = os.path.splitext(secure_filename(f.filename or ""))[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        return api_error("Unsupported file type", "BAD_REQUEST", 400)
    file_id = str(uuid.uuid4()) + ext
    if "/" in file_id or "\\" in file_id:
        return api_error("Invalid file extension", "BAD_REQUEST", 400)
    f.save(os.path.join(upload_dir, file_id))
    return jsonify({"file_id": file_id})


@upload_export_bp.route("/api/export/step", methods=["POST"])
@require_auth
@require_csrf
def export_step():
    data = request.get_json(silent=True)
    if not data or "features" not in data:
        return api_error("features required", "BAD_REQUEST", 400)

    return api_error("solver kernel not available", "SERVICE_UNAVAILABLE", 503)


@upload_export_bp.route("/api/export/stl", methods=["POST"])
@require_auth
@require_csrf
def export_stl():
    data = request.get_json(silent=True)
    if not data or "features" not in data:
        return api_error("features required", "BAD_REQUEST", 400)

    return api_error("solver kernel not available", "SERVICE_UNAVAILABLE", 503)
