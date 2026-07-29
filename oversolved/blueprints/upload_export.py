"""File upload and STEP/STL export routes."""

import os
import uuid
from flask import Blueprint, current_app, jsonify, request
from werkzeug.utils import secure_filename
from oversolved.blueprints import auth_required, api_error

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
@auth_required()
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
