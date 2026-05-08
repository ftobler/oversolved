"""File upload and STEP/STL export routes."""

import os
import uuid
from flask import Blueprint, jsonify, request, Response
from werkzeug.utils import secure_filename
from oversolved.blueprints import require_auth, require_csrf

upload_export_bp = Blueprint("upload_export", __name__)

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "..", "uploads")
ALLOWED_EXTENSIONS = {".step", ".stp", ".iges", ".igs"}


@upload_export_bp.route("/api/upload", methods=["POST"])
@require_auth
@require_csrf
def upload_file():
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    if "file" not in request.files:
        return jsonify({"error": "no file field"}), 400
    f = request.files["file"]
    ext = os.path.splitext(secure_filename(f.filename or ""))[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        return jsonify({"error": "Unsupported file type"}), 400
    file_id = str(uuid.uuid4()) + ext
    if "/" in file_id or "\\" in file_id:
        return jsonify({"error": "Invalid file extension"}), 400
    f.save(os.path.join(UPLOAD_DIR, file_id))
    return jsonify({"file_id": file_id})


@upload_export_bp.route("/api/export/step", methods=["POST"])
@require_auth
@require_csrf
def export_step():
    data = request.get_json(silent=True)
    if not data or "features" not in data:
        return jsonify({"error": "features required"}), 400

    from oversolved.kernel.builder import build

    build_result = build(data)

    body_shapes = build_result.get("_body_shapes", {})
    if not body_shapes:
        return jsonify({"error": "no bodies to export"}), 400

    from oversolved.kernel.geometry import shape_to_step_file_buffer, fuse_shapes
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


@upload_export_bp.route("/api/export/stl", methods=["POST"])
@require_auth
@require_csrf
def export_stl():
    data = request.get_json(silent=True)
    if not data or "features" not in data:
        return jsonify({"error": "features required"}), 400

    from oversolved.kernel.builder import build

    build_result = build(data)

    body_shapes = build_result.get("_body_shapes", {})
    if not body_shapes:
        return jsonify({"error": "no bodies to export"}), 400

    from oversolved.kernel.geometry import shape_to_stl_file_buffer, fuse_shapes

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
