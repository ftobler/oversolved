"""Cache inspection routes."""

import json
from pathlib import Path
from datetime import datetime
from flask import Blueprint, jsonify, request, Response, current_app, send_file
from oversolved.blueprints import require_auth, require_admin

cache_inspect_bp = Blueprint("cache_inspect", __name__)


def _estimate_shape_size(shape):
    """Estimate serialized size of an OCC shape in bytes."""
    try:
        from oversolved.geometry import shape_to_step_file_buffer
        buf = shape_to_step_file_buffer(shape)
        return len(buf.getvalue())
    except Exception:
        return 0


def _truncate_json_to_keys(data: dict, max_keys: int = 10) -> dict:
    """Return a truncated version of a dict showing only top-level key names and value types."""
    truncated = {}
    for i, (k, v) in enumerate(data.items()):
        if i >= max_keys:
            truncated[f"... and {len(data) - max_keys} more keys"] = "..."
            break
        if isinstance(v, dict):
            truncated[k] = f"<dict with {len(v)} keys>"
        elif isinstance(v, list):
            truncated[k] = f"<list with {len(v)} items>"
        else:
            truncated[k] = v
    return truncated


@cache_inspect_bp.route("/api/cache/flush", methods=["POST"])
@require_auth
@require_admin
def flush_cache():
    data = request.get_json(silent=True) or {}
    doc_id = data.get("doc_id", "").strip()
    level = data.get("level", "all")

    if not doc_id:
        return jsonify({"error": "doc_id required"}), 400

    cache = current_app.extensions.get("build_state_cache")
    l2_cache = current_app.extensions.get("l2_cache")

    if level in ("l1", "all") and cache:
        cache.delete(doc_id)

    if level in ("l2", "all") and l2_cache and current_app.config.get("L2_CACHE_ENABLED"):
        l2_cache.delete(doc_id)

    return jsonify({"status": "flushed", "doc_id": doc_id, "level": level})


@cache_inspect_bp.route("/api/cache/inspect", methods=["GET"])
@require_auth
@require_admin
def inspect_cache():
    cache = current_app.extensions.get("build_state_cache")
    l1_entries = []
    if cache:
        for doc_id, (state, accessed_time) in cache.get_entries().items():
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
    l2_cache = current_app.extensions.get("l2_cache")
    if l2_cache and current_app.config.get("L2_CACHE_ENABLED"):
        cache_dir = Path(l2_cache.get_cache_dir())
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


@cache_inspect_bp.route("/api/cache/inspect/l2/<doc_id>", methods=["GET"])
@require_auth
@require_admin
def inspect_l2_entry(doc_id):
    l2_cache = current_app.extensions.get("l2_cache")
    if not l2_cache or not current_app.config.get("L2_CACHE_ENABLED"):
        return jsonify({"error": "L2 cache not enabled"}), 400

    file_path = Path(l2_cache.get_cache_dir()) / f"{doc_id}.json"
    if not file_path.exists():
        return jsonify({"error": f"Entry not found: {doc_id}"}), 404

    with open(file_path, encoding="utf-8") as f:
        data = json.load(f)

    json_str = json.dumps(data, indent=2)
    if len(json_str) > 50000:
        preview = _truncate_json_to_keys(data)
        return jsonify({"truncated": True, "preview": preview})
    return Response(json_str, mimetype="application/json")


@cache_inspect_bp.route("/api/cache/download/<doc_id>", methods=["GET"])
@require_auth
@require_admin
def download_l2_entry(doc_id):
    l2_cache = current_app.extensions.get("l2_cache")
    if not l2_cache or not current_app.config.get("L2_CACHE_ENABLED"):
        return jsonify({"error": "L2 cache not enabled"}), 400

    file_path = Path(l2_cache.get_cache_dir()) / f"{doc_id}.json"
    if not file_path.exists():
        return jsonify({"error": f"Entry not found: {doc_id}"}), 404

    return send_file(str(file_path), mimetype="application/json", as_attachment=True, download_name=f"{doc_id}.json")
