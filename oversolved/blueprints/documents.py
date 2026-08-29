"""Document CRUD, share, trash, clone, import, thumbnail routes."""

import base64
from io import BytesIO
from datetime import datetime, timedelta, timezone
from flask import Blueprint, jsonify, request, Response
from PIL import Image
from oversolved.db import DocumentStore, UserStore, RebuildTimeStore, _now
from flask import g
from oversolved.blueprints import get_db, auth_required, api_error

documents_bp = Blueprint("documents", __name__, url_prefix="/api/documents")


def decode_png(image_data: bytes) -> Image.Image:
    """Pillow-open thumbnail bytes and insist they really are PNG.

    Both thumbnail write paths share this gate because GET /thumbnail serves
    stored bytes with a hardcoded image/png content type; accepting JPEG or
    webp bytes here would ship them mislabelled to browsers. Validation is
    strict rather than re-encoding so stored previews stay byte-identical to
    what the client sent.
    """
    img = Image.open(BytesIO(image_data))
    if img.format != "PNG":
        raise ValueError(f"expected PNG image data, got {img.format}")
    return img


@documents_bp.route("", methods=["GET"])
@auth_required()
def list_documents():
    sort = request.args.get("sort", "name")
    search_query = request.args.get("search", "").strip()

    include_shared = request.args.get("include_shared", "").lower()
    filter_type = request.args.get("filter", "")
    if not filter_type:
        filter_type = "all" if include_shared in ("", "true") else "owned"

    # The listing query selects no preview column at all; previews are heavy
    # blobs that are only ever served per document via GET /<uuid>.
    docs = DocumentStore(get_db()).list_by_filter(
        g.current_user["id"], filter_type, sort, search_query
    )
    return jsonify({"documents": docs})


@documents_bp.route("", methods=["POST"])
@auth_required(json=True)
def create_document():
    data = request.get_json()
    name = (data.get("name") or "").strip()
    if not name:
        return api_error("Document name required", "BAD_REQUEST", 400)
    is_public = bool(data.get("is_public", False))
    db = get_db()
    doc_uuid = DocumentStore(db).create(name, g.current_user["id"], is_public)
    return jsonify({"uuid": doc_uuid, "name": name}), 201


@documents_bp.route("/<uuid>", methods=["GET"])
@auth_required(doc="view")
def get_document(uuid):
    doc = g.document
    owner = UserStore(get_db()).find_by_id(doc["owner_id"])
    owner_username = owner["username"] if owner else "Unknown"
    response = {
        "uuid": doc["uuid"],
        "name": doc["name"],
        "content": doc["content"],
        "permission": g.document_permission,
        "owner_username": owner_username,
        "is_public": doc["is_public"],
    }
    if doc["preview_image"]:
        response["preview_image"] = base64.b64encode(doc["preview_image"]).decode(
            "utf-8"
        )
    return jsonify(response)


@documents_bp.route("/<uuid>", methods=["PUT"])
@auth_required(doc="edit", json=True)
def update_document(uuid):
    data = request.get_json()
    if "content" not in data:
        return api_error('Missing "content" field', "BAD_REQUEST", 400)
    content = data["content"]
    if not isinstance(content, str):
        return api_error('"content" must be a string', "BAD_REQUEST", 400)
    image_data = None
    if data.get("preview_image"):
        # Validated (and decoded) before any write, so a malformed image
        # can't leave the content half of this request committed while the
        # response reports failure. PNG-only: see decode_png for why.
        try:
            decoded = base64.b64decode(data["preview_image"])
            img = decode_png(decoded)
            oversized = img.width > 1024 or img.height > 1024
        except Exception:
            return api_error("Invalid image data", "BAD_REQUEST", 400)
        if oversized:
            return api_error("Invalid image", "BAD_REQUEST", 400)
        image_data = decoded
    db = get_db()
    doc_store = DocumentStore(db)
    doc_store.update_content(uuid, content, image_data)
    return jsonify({"uuid": uuid, "status": "stored"}), 200


@documents_bp.route("/<uuid>", methods=["PATCH"])
@auth_required(doc="owner", json=True)
def rename_document(uuid):
    data = request.get_json()
    # Same guard as import_document: a non-string name would crash strip()
    # into a 500. Absent or null keeps the blank-name rejection below.
    if data.get("name") is not None and not isinstance(data["name"], str):
        return api_error('"name" must be a string', "BAD_REQUEST", 400)
    name = (data.get("name") or "").strip()
    if not name:
        return api_error("Document name required", "BAD_REQUEST", 400)
    if not DocumentStore(get_db()).rename(uuid, name):
        # The permission gate already 404s a missing document before this line;
        # checking rowcount keeps that contract intact even when the row
        # vanishes between the gate and the write, so a rename can never
        # answer 200 without having renamed anything.
        return api_error("Document not found", "NOT_FOUND", 404)
    return jsonify({"uuid": uuid, "name": name})


@documents_bp.route("/<uuid>", methods=["DELETE"])
@auth_required(doc="owner")
def delete_document(uuid):
    deleted_at = _now()
    DocumentStore(get_db()).update(uuid, deleted_at=deleted_at)
    return jsonify({
        "uuid": uuid,
        "status": "moved_to_trash",
        "deleted_at": deleted_at,
        "expires_at": (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
    }), 200


@documents_bp.route("/trash", methods=["GET"])
@auth_required()
def list_trash():
    docs = DocumentStore(get_db()).list_trash(g.current_user["id"])
    return jsonify({"documents": docs})


@documents_bp.route("/<uuid>/recover", methods=["POST"])
@auth_required(doc="owner")
def recover_document(uuid):
    doc = g.document

    if doc["deleted_at"] is None:
        return api_error("Document is not in trash", "BAD_REQUEST", 400)

    deleted_time = datetime.fromisoformat(doc["deleted_at"])
    if deleted_time.tzinfo is None:
        deleted_time = deleted_time.replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) - deleted_time > timedelta(days=30):
        return api_error("Document has expired and cannot be recovered", "GONE", 410)

    DocumentStore(get_db()).update(uuid, deleted_at=None)
    return jsonify({"uuid": uuid, "status": "recovered", "deleted_at": None})


@documents_bp.route("/<uuid>/trash", methods=["DELETE"])
@auth_required(doc="owner")
def permanently_delete_from_trash(uuid):
    if g.document["deleted_at"] is None:
        return api_error("Document is not in trash", "BAD_REQUEST", 400)

    DocumentStore(get_db()).permanently_delete(uuid)
    return jsonify({"uuid": uuid, "status": "permanently_deleted"})


@documents_bp.route("/<uuid>/duplicate", methods=["POST"])
@auth_required(doc="owner")
def duplicate_document(uuid):
    new_name = f"{g.document['name']} (Copy)"
    new_uuid = DocumentStore(get_db()).duplicate(uuid, new_name)
    return jsonify({"uuid": new_uuid, "name": new_name}), 201


@documents_bp.route("/<uuid>/clone", methods=["POST"])
@auth_required(doc="view")
def clone_document(uuid):
    doc = g.document
    doc_store = DocumentStore(get_db())

    # The caller may name the clone (the UI prompts with the suggested name
    # prefilled). An explicit name is taken verbatim: the user saw it and chose
    # it, so silently uniquifying it would be a surprise.
    requested = (request.get_json(silent=True) or {}).get("name")
    if isinstance(requested, str) and requested.strip():
        new_name = requested.strip()
    else:
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
@auth_required(doc="owner", json=True)
def create_share(uuid):
    data = request.get_json()
    db = get_db()
    doc_store = DocumentStore(db)

    username = data.get("username")
    permission = data.get("permission", "view")
    if permission not in ("view", "edit"):
        return api_error("Invalid permission", "BAD_REQUEST", 400)

    # An absent username key is the public link-share request. A present but
    # blank one must fail loudly here: falling into the falsy branch would
    # silently publish the document instead of sharing it with anyone.
    if "username" in data and (
        not isinstance(data["username"], str) or not data["username"].strip()
    ):
        return api_error("Username required", "BAD_REQUEST", 400)

    if username:
        user = UserStore(db).find_by_username(username)
        if user is None:
            return api_error("User not found", "NOT_FOUND", 404)
        doc_store.share_document(uuid, user["id"], permission)
    else:
        doc_store.set_public(uuid, True)

    return jsonify({"status": "shared"}), 201


@documents_bp.route("/<uuid>/share", methods=["DELETE"])
@auth_required(doc="view")
def remove_share(uuid):
    # Self-unshare is allowed at "view" level; owner ops guarded per-branch below.
    data = request.get_json(silent=True) or {}
    db = get_db()
    doc_store = DocumentStore(db)
    doc = g.document

    # Mirror of the create_share guard: an absent key keeps today's
    # behavior, but a present yet blank username must fail loudly rather
    # than silently unpublishing or self-unsharing.
    if "username" in data and (
        not isinstance(data["username"], str) or not data["username"].strip()
    ):
        return api_error("Username required", "BAD_REQUEST", 400)

    username = data.get("username")
    if username:
        user = UserStore(db).find_by_username(username)
        if user is None:
            return api_error("User not found", "NOT_FOUND", 404)
        if doc["owner_id"] != g.current_user["id"] and g.current_user["username"] != username:
            return api_error("Forbidden", "FORBIDDEN", 403)
        doc_store.unshare_document(uuid, user["id"])
    else:
        if doc["owner_id"] == g.current_user["id"]:
            doc_store.set_public(uuid, False)
        else:
            doc_store.unshare_document(uuid, g.current_user["id"])

    return jsonify({"status": "unshared"}), 200


@documents_bp.route("/<uuid>/shares", methods=["GET"])
@auth_required(doc="owner")
def list_shares(uuid):
    shares = DocumentStore(get_db()).get_shares(uuid)
    return jsonify({"shares": shares})


@documents_bp.route("/<uuid>/export", methods=["GET"])
@auth_required(doc="view")
def export_document(uuid):
    doc = g.document
    return jsonify({"name": doc["name"], "content": doc["content"]})


@documents_bp.route("/<uuid>/thumbnail", methods=["GET"])
@auth_required(doc="view")
def get_thumbnail(uuid):
    doc = g.document
    if not doc["preview_image"]:
        return "", 404
    return Response(doc["preview_image"], mimetype="image/png")


@documents_bp.route("/<doc_id>/rebuild-stats", methods=["GET"])
@auth_required(doc="view", doc_url_var="doc_id")
def rebuild_stats(doc_id):
    stats = RebuildTimeStore(get_db()).compute_stats(doc_id)
    return jsonify(stats)


@documents_bp.route("/import", methods=["POST"])
@auth_required(json=True)
def import_document():
    data = request.get_json()
    # Same guard as rename_document: a non-string name would crash strip()
    # into a 500. Absent or null keeps the blank-name rejection below.
    if data.get("name") is not None and not isinstance(data["name"], str):
        return api_error('"name" must be a string', "BAD_REQUEST", 400)
    name = (data.get("name") or "").strip()
    content = data.get("content")
    if content is None:
        content = ""
    # Match update_document: a non-string payload would either 500 in
    # psycopg2 or be silently stringified into the stored document.
    if not isinstance(content, str):
        return api_error('"content" must be a string', "BAD_REQUEST", 400)
    if not name:
        return api_error("Document name required", "BAD_REQUEST", 400)
    doc_store = DocumentStore(get_db())
    uuid = doc_store.import_document(name, g.current_user["id"], content)
    return jsonify({"uuid": uuid, "name": name}), 201
