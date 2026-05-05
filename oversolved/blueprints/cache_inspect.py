"""Cache inspection routes."""

from datetime import datetime
from flask import Blueprint, jsonify, request, current_app
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

    if level in ("l1", "all") and cache:
        cache.delete(doc_id)

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

    return jsonify({"l1": l1_entries})
