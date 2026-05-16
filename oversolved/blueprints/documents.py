"""Document CRUD, share, trash, clone, import, thumbnail routes."""

import base64
from io import BytesIO
from datetime import datetime, timedelta, timezone
from flask import Blueprint, jsonify, request, Response
from PIL import Image
from oversolved.db import DocumentStore, UserStore
from flask import g
from oversolved.blueprints import get_db, require_auth, require_csrf

documents_bp = Blueprint("documents", __name__, url_prefix="/api/documents")


@documents_bp.route("", methods=["GET"])
@require_auth
@require_csrf
def list_documents():
    sort = request.args.get("sort", "name")
    search_query = request.args.get("search", "").strip()

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


@documents_bp.route("", methods=["POST"])
@require_auth
@require_csrf
def create_document():
    if not request.is_json:
        return jsonify({"error": "Content-Type must be application/json"}), 400
    data = request.get_json()
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Document name required"}), 400
    is_public = bool(data.get("is_public", False))
    db = get_db()
    doc_uuid = DocumentStore(db).create(name, g.current_user["id"], is_public)
    return jsonify({"uuid": doc_uuid, "name": name}), 201


@documents_bp.route("/<uuid>", methods=["GET"])
@require_auth
@require_csrf
def get_document(uuid):
    doc_store = DocumentStore(get_db())
    doc = doc_store.retrieve(uuid)
    if doc is None:
        return jsonify({"error": "Document not found"}), 404
    permission = doc_store.get_permission(uuid, g.current_user["id"])
    if permission is None:
        return jsonify({"error": "Forbidden"}), 403
    user_store = UserStore(get_db())
    owner = user_store.find_by_id(doc["owner_id"])
    owner_username = owner["username"] if owner else "Unknown"
    response = {
        "uuid": doc["uuid"],
        "name": doc["name"],
        "content": doc["content"],
        "permission": permission,
        "owner_username": owner_username,
        "is_public": doc["is_public"],
    }
    if doc["preview_image"]:
        response["preview_image"] = base64.b64encode(doc["preview_image"]).decode(
            "utf-8"
        )
    return jsonify(response)


@documents_bp.route("/<uuid>", methods=["PUT"])
@require_auth
@require_csrf
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
        doc_store.create_with_uuid(uuid, "Imported Document", g.current_user["id"])
    else:
        permission = doc_store.get_permission(uuid, g.current_user["id"])
        if permission not in ("owner", "edit"):
            return jsonify({"error": "Forbidden"}), 403
    doc_store.store_content(uuid, content)
    if data.get("preview_image"):
        image_data = base64.b64decode(data["preview_image"])
        try:
            img = Image.open(BytesIO(image_data))
            if img.width > 512 or img.height > 512:
                return jsonify({"error": "Invalid image"}), 400
        except Exception:
            return jsonify({"error": "Invalid image data"}), 400
        doc_store.store_preview_image(uuid, image_data)
    return jsonify({"uuid": uuid, "status": "stored"}), 200


@documents_bp.route("/<uuid>", methods=["PATCH"])
@require_auth
@require_csrf
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


@documents_bp.route("/<uuid>", methods=["DELETE"])
@require_auth
@require_csrf
def delete_document(uuid):
    db = get_db()
    doc_store = DocumentStore(db)
    doc = doc_store.retrieve(uuid)
    if doc is None:
        return jsonify({"error": "Document not found"}), 404
    permission = doc_store.get_permission(uuid, g.current_user["id"])
    if permission != "owner":
        return jsonify({"error": "Forbidden"}), 403
    deleted_at = datetime.now(timezone.utc).isoformat()
    doc_store.update(uuid, deleted_at=deleted_at)
    return jsonify({
        "uuid": uuid,
        "status": "moved_to_trash",
        "deleted_at": deleted_at,
        "expires_at": (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
    }), 200


@documents_bp.route("/trash", methods=["GET"])
@require_auth
@require_csrf
def list_trash():
    docs = DocumentStore(get_db()).list_trash(g.current_user["id"])
    return jsonify({"documents": docs})


@documents_bp.route("/<uuid>/recover", methods=["POST"])
@require_auth
@require_csrf
def recover_document(uuid):
    doc_store = DocumentStore(get_db())
    doc = doc_store.retrieve(uuid)

    if doc is None:
        return jsonify({"error": "Document not found"}), 404

    if doc["owner_id"] != g.current_user["id"]:
        return jsonify({"error": "Forbidden"}), 403

    if doc["deleted_at"] is None:
        return jsonify({"error": "Document is not in trash"}), 400

    deleted_time = datetime.fromisoformat(doc["deleted_at"])
    if deleted_time.tzinfo is None:
        deleted_time = deleted_time.replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) - deleted_time > timedelta(days=30):
        return jsonify({"error": "Document has expired and cannot be recovered"}), 410

    doc_store.update(uuid, deleted_at=None)
    return jsonify({"uuid": uuid, "status": "recovered", "deleted_at": None})


@documents_bp.route("/<uuid>/trash", methods=["DELETE"])
@require_auth
@require_csrf
def permanently_delete_from_trash(uuid):
    doc_store = DocumentStore(get_db())
    doc = doc_store.retrieve(uuid)

    if doc is None:
        return jsonify({"error": "Document not found"}), 404

    if doc["owner_id"] != g.current_user["id"]:
        return jsonify({"error": "Forbidden"}), 403

    if doc["deleted_at"] is None:
        return jsonify({"error": "Document is not in trash"}), 400

    doc_store.permanently_delete(uuid)
    return jsonify({"uuid": uuid, "status": "permanently_deleted"})


@documents_bp.route("/<uuid>/duplicate", methods=["POST"])
@require_auth
@require_csrf
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


@documents_bp.route("/<uuid>/clone", methods=["POST"])
@require_auth
@require_csrf
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


@documents_bp.route("/<uuid>/share", methods=["POST"])
@require_auth
@require_csrf
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


@documents_bp.route("/<uuid>/share", methods=["DELETE"])
@require_auth
@require_csrf
def remove_share(uuid):
    data = request.get_json(silent=True) or {}
    db = get_db()
    doc_store = DocumentStore(db)
    doc = doc_store.retrieve(uuid)
    if doc is None:
        return jsonify({"error": "Document not found"}), 404

    username = data.get("username")
    if username:
        user = UserStore(db).find_by_username(username)
        if user is None:
            return jsonify({"error": "User not found"}), 404
        if doc["owner_id"] != g.current_user["id"] and g.current_user["username"] != username:
            return jsonify({"error": "Forbidden"}), 403
        doc_store.unshare_document(uuid, user["id"])
    else:
        if doc["owner_id"] == g.current_user["id"]:
            doc_store.set_public(uuid, False)
        else:
            doc_store.unshare_document(uuid, g.current_user["id"])

    return jsonify({"status": "unshared"}), 200


@documents_bp.route("/<uuid>/shares", methods=["GET"])
@require_auth
@require_csrf
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


@documents_bp.route("/<uuid>/export", methods=["GET"])
@require_auth
@require_csrf
def export_document(uuid):
    doc_store = DocumentStore(get_db())
    doc = doc_store.retrieve(uuid)
    if doc is None:
        return jsonify({"error": "Document not found"}), 404
    if not doc_store.has_permission(uuid, g.current_user["id"], "view"):
        return jsonify({"error": "Forbidden"}), 403
    return jsonify({"name": doc["name"], "content": doc["content"]})


@documents_bp.route("/<uuid>/thumbnail", methods=["GET"])
@require_auth
@require_csrf
def get_thumbnail(uuid):
    doc_store = DocumentStore(get_db())
    doc = doc_store.retrieve(uuid)
    if doc is None:
        return jsonify({"error": "Document not found"}), 404
    if not doc_store.has_permission(uuid, g.current_user["id"], "view"):
        return jsonify({"error": "Forbidden"}), 403
    if not doc["preview_image"]:
        return "", 404
    return Response(doc["preview_image"], mimetype="image/png")


@documents_bp.route("/<doc_id>/rebuild-stats", methods=["GET"])
@require_auth
@require_csrf
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


@documents_bp.route("/import", methods=["POST"])
@require_auth
@require_csrf
def import_document():
    if not request.is_json:
        return jsonify({"error": "Content-Type must be application/json"}), 400
    data = request.get_json()
    name = (data.get("name") or "").strip()
    content = data.get("content") or ""
    if not name:
        return jsonify({"error": "Document name required"}), 400
    db = get_db()
    doc_store = DocumentStore(db)
    with db.transaction():
        uuid = doc_store.create(name, g.current_user["id"])
        doc_store.store_content(uuid, content)
    return jsonify({"uuid": uuid, "name": name}), 201
