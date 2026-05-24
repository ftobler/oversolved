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
        return current_app.config["UPLOAD_DIR"]
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

    if not importlib.util.find_spec("cadquery"):
        return api_error("solver kernel not available (install oversolved[solver])", "SERVICE_UNAVAILABLE", 503)

    from oversolved.kernel.builder import build
    from oversolved.kernel.geometry_io import shape_to_step_file_buffer
    from oversolved.kernel.cadquery_ops import fuse_shapes

    build_result = build(data)

    body_shapes = build_result.get("_body_shapes", {})
    if not body_shapes:
        return api_error("no bodies to export", "BAD_REQUEST", 400)

    body_id = (data.get("body_id") or "").strip() if isinstance(data, dict) else ""

    if body_id:
        shape = body_shapes.get(body_id)
        if shape is None:
            return api_error(f"body {body_id!r} not found", "NOT_FOUND", 400)
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


@upload_export_bp.route("/api/export/stl", methods=["POST"])
@require_auth
@require_csrf
def export_stl():
    data = request.get_json(silent=True)
    if not data or "features" not in data:
        return api_error("features required", "BAD_REQUEST", 400)

    if not importlib.util.find_spec("cadquery"):
        return api_error("solver kernel not available (install oversolved[solver])", "SERVICE_UNAVAILABLE", 503)

    from oversolved.kernel.builder import build

    build_result = build(data)

    body_shapes = build_result.get("_body_shapes", {})
    if not body_shapes:
        return api_error("no bodies to export", "BAD_REQUEST", 400)

    from oversolved.kernel.geometry_io import shape_to_stl_file_buffer
    from oversolved.kernel.cadquery_ops import fuse_shapes

    deflection = data.get("deflection", 0.5)
    angular_deflection = data.get("angular_deflection", 0.3)
    body_id = (data.get("body_id") or "").strip() if isinstance(data, dict) else ""

    if body_id:
        shape = body_shapes.get(body_id)
        if shape is None:
            return api_error(f"body {body_id!r} not found", "NOT_FOUND", 400)
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
