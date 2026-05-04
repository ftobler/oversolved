"""Solver and rebuild-stats routes."""

import json
from flask import Blueprint, jsonify, request, Response, current_app
from oversolved.blueprints import require_auth, get_db
from oversolved.cache import TtlCache
from oversolved.types3d import BuildState

solver_bp = Blueprint("solver", __name__)


@solver_bp.route("/api/solve", methods=["POST"])
@require_auth
def solve_document():
    data = request.get_json(silent=True)
    if not data or "features" not in data:
        return jsonify({"error": "features required"}), 400

    from oversolved.builder import build

    doc_id = data.get("id")
    rollback_position = data.get("rollback_position")
    pick_boundary = data.get("pick_boundary")

    from oversolved.solver_queue import get_document_solver

    cache: TtlCache[BuildState] | None = current_app.extensions.get("build_state_cache")
    l2_enabled = current_app.config.get("L2_CACHE_ENABLED", False)
    l2_cache = current_app.extensions.get("l2_cache") if l2_enabled else None

    prev_state: BuildState | None = None
    if doc_id:
        solver = get_document_solver()
        counter = solver.acquire(doc_id)
        try:
            prev_state = cache.get(doc_id) if cache else None
            if prev_state is None and l2_cache:
                prev_state = l2_cache.get(doc_id)
                if prev_state is not None and cache:
                    cache.set(doc_id, prev_state)

            build_result = build(
                data,
                prev_state=prev_state,
                pick_boundary=pick_boundary,
                rollback_position=rollback_position,
            )
            new_state = build_result.pop("_build_state")
            if cache:
                cache.set(doc_id, new_state)
            if l2_cache:
                l2_cache.set(doc_id, new_state)
            solver.release(doc_id, counter, build_result)

            duration_ms = build_result.get("solve_ms")
            feature_count = len(data.get("features", []))
            if duration_ms is not None:
                db = get_db()
                db.execute(
                    """INSERT INTO rebuild_times (document_uuid, duration_ms, feature_count)
                       VALUES (?, ?, ?)""",
                    (doc_id, round(duration_ms), feature_count),
                )
                db.commit()

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


@solver_bp.route("/api/documents/<doc_id>/rebuild-stats", methods=["GET"])
@require_auth
def rebuild_stats(doc_id):
    db = get_db()

    cursor = db.execute("SELECT uuid FROM documents WHERE uuid = ?", (doc_id,))
    if cursor.fetchone() is None:
        return jsonify({"error": "Document not found"}), 404

    cursor = db.execute(
        """SELECT duration_ms FROM rebuild_times
           WHERE document_uuid = ?
           ORDER BY id DESC""",
        (doc_id,),
    )
    rows = cursor.fetchall()
    if not rows:
        return jsonify({
            "rebuild_count": 0,
            "last_duration_ms": None,
            "average_ms": None,
            "median_ms": None,
            "min_ms": None,
            "max_ms": None,
            "trend": None,
            "history": [],
        })

    all_durations = [r[0] for r in rows]
    count = len(all_durations)
    last_ms = all_durations[0]
    avg_ms = sum(all_durations) / count
    sorted_d = sorted(all_durations)
    n = count
    if n % 2 == 1:
        median_ms = float(sorted_d[n // 2])
    else:
        median_ms = (sorted_d[n // 2 - 1] + sorted_d[n // 2]) / 2.0
    min_ms = sorted_d[0]
    max_ms = sorted_d[-1]

    if count >= 2:
        recent = all_durations[:5]
        older = all_durations[-5:] if count >= 5 else all_durations[1:]
        recent_avg = sum(recent) / len(recent)
        older_avg = sum(older) / len(older)
        if recent_avg < older_avg * 0.9:
            trend = "faster"
        elif recent_avg > older_avg * 1.1:
            trend = "slower"
        else:
            trend = "stable"
    else:
        trend = None

    history = all_durations[:20]

    return jsonify({
        "rebuild_count": count,
        "last_duration_ms": last_ms,
        "average_ms": avg_ms,
        "median_ms": median_ms,
        "min_ms": min_ms,
        "max_ms": max_ms,
        "trend": trend,
        "history": history,
    })
