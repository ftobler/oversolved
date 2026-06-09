"""User profile and preferences routes."""

from flask import Blueprint, jsonify, request, g
from werkzeug.security import generate_password_hash, check_password_hash
from oversolved.db import UserStore
from oversolved.blueprints import get_db, require_auth, require_csrf, validate_password_strength, api_error

users_bp = Blueprint("users", __name__, url_prefix="/api/users/me")

_VALID_SORT_PREFS = {"alphabetical", "date_newest_first", "date_oldest_first"}


@users_bp.route("", methods=["PUT"])
@require_auth
@require_csrf
def update_profile():
    if not request.is_json:
        return api_error("Content-Type must be application/json", "INVALID_CONTENT_TYPE", 400)
    data = request.get_json()
    username = data.get("username")
    email = data.get("email")
    current_password = data.get("current_password", "")
    new_password = data.get("new_password", "")

    db = get_db()
    user_store = UserStore(db)
    user_id = g.current_user["id"]

    updates = {}
    if username and username.strip():
        updates["username"] = username.strip()

    if email and email.strip():
        updates["email"] = email.strip()

    if new_password:
        pw_error = validate_password_strength(new_password)
        if pw_error:
            return api_error(pw_error, "VALIDATION_ERROR", 400)
        if not current_password:
            return api_error("Current password required to change password", "BAD_REQUEST", 400)
        user = user_store.find_by_id(user_id)
        if user is None:
            return api_error("User not found", "NOT_FOUND", 404)
        full_user = user_store.find_by_username(user["username"])
        if full_user is None or not check_password_hash(full_user["password_hash"], current_password):
            return api_error("Current password is incorrect", "BAD_REQUEST", 400)
        updates["password_hash"] = generate_password_hash(new_password)
        updates["must_change_password"] = 0

    if updates:
        success = user_store.update(user_id, **updates)
        if not success:
            return api_error("User not found", "NOT_FOUND", 404)

    return jsonify({"status": "updated"})


@users_bp.route("/preferences", methods=["GET"])
@require_auth
def get_preferences():
    user_id = g.current_user["id"]
    user = UserStore(get_db()).find_by_id(user_id)
    if user is None:
        return api_error("User not found", "NOT_FOUND", 404)
    return jsonify({
        "document_sort": user["document_sort_preference"]
    })


@users_bp.route("/preferences", methods=["PUT"])
@require_auth
@require_csrf
def update_preferences():
    if not request.is_json:
        return api_error("Content-Type must be application/json", "INVALID_CONTENT_TYPE", 400)
    data = request.get_json()
    document_sort = data.get("document_sort", "").strip()
    if not document_sort:
        return api_error("document_sort is required", "BAD_REQUEST", 400)
    if document_sort not in _VALID_SORT_PREFS:
        return api_error("Invalid document_sort value", "BAD_REQUEST", 400)
    user_id = g.current_user["id"]
    success = UserStore(get_db()).update(user_id, document_sort_preference=document_sort)
    if not success:
        return api_error("User not found", "NOT_FOUND", 404)
    return jsonify({"status": "updated", "document_sort": document_sort})
