"""User profile and preferences routes."""

from typing import Any

from flask import Blueprint, jsonify, request, g
from werkzeug.security import generate_password_hash, check_password_hash
from oversolved.db import UserStore, SessionStore
from oversolved.blueprints import get_db, auth_required, validate_password_strength, api_error, integrity_error_types

users_bp = Blueprint("users", __name__, url_prefix="/api/users/me")

_VALID_SORT_PREFS = {"alphabetical", "date_newest_first", "date_oldest_first"}


@users_bp.route("", methods=["PUT"])
@auth_required(json=True)
def update_profile():
    data = request.get_json()
    username = data.get("username")
    email = data.get("email")
    current_password = data.get("current_password", "")
    new_password = data.get("new_password", "")

    # Non-string scalars would crash .strip(), len() or hash checks below;
    # reject them as client errors.
    if username is not None and not isinstance(username, str):
        return api_error("Username must be a string", "BAD_REQUEST", 400)
    if email is not None and not isinstance(email, str):
        return api_error("Email must be a string", "BAD_REQUEST", 400)
    if new_password is not None and not isinstance(new_password, str):
        return api_error("New password must be a string", "BAD_REQUEST", 400)
    if current_password is not None and not isinstance(current_password, str):
        return api_error("Current password must be a string", "BAD_REQUEST", 400)

    db = get_db()
    user_store = UserStore(db)
    user_id = g.current_user["id"]

    # Annotated because mypy otherwise pins the value type from the first write.
    updates: dict[str, Any] = {}
    if username and username.strip():
        new_username = username.strip()
        # Pre-check so a taken name answers 409 instead of an IntegrityError 500.
        existing = user_store.find_by_username(new_username)
        if existing is not None and existing["id"] != user_id:
            return api_error("Username already exists", "CONFLICT", 409)
        updates["username"] = new_username

    if email and email.strip():
        new_email = email.strip()
        # Pre-check so a taken address answers 409 instead of an IntegrityError 500.
        existing = user_store.find_by_email(new_email)
        if existing is not None and existing["id"] != user_id:
            return api_error("Email already exists", "CONFLICT", 409)
        updates["email"] = new_email

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
        try:
            success = user_store.update(user_id, **updates)
        except integrity_error_types():
            # Lost a race with the pre-check above: the new username or email was
            # taken by another account between the check and the write.
            return api_error("Username or email already exists", "CONFLICT", 409)
        if not success:
            return api_error("User not found", "NOT_FOUND", 404)
        if "password_hash" in updates:
            # A new hash alone does not stop old tokens from authenticating for
            # the rest of their 30 day lifetime; revoke the account's other
            # sessions while sparing the one that performed this change.
            SessionStore(db).revoke_all_for_user(
                user_id, keep_token=request.cookies.get("session_token")
            )

    return jsonify({"status": "updated"})


@users_bp.route("/preferences", methods=["GET"])
@auth_required()
def get_preferences():
    user_id = g.current_user["id"]
    user = UserStore(get_db()).find_by_id(user_id)
    if user is None:
        return api_error("User not found", "NOT_FOUND", 404)
    return jsonify({
        "document_sort": user["document_sort_preference"]
    })


@users_bp.route("/preferences", methods=["PUT"])
@auth_required(json=True)
def update_preferences():
    data = request.get_json()
    raw_sort = data.get("document_sort", "")
    # A non-string scalar such as null would crash .strip(); reject it as client error.
    if not isinstance(raw_sort, str):
        return api_error("document_sort must be a string", "BAD_REQUEST", 400)
    document_sort = raw_sort.strip()
    if not document_sort:
        return api_error("document_sort is required", "BAD_REQUEST", 400)
    if document_sort not in _VALID_SORT_PREFS:
        return api_error("Invalid document_sort value", "BAD_REQUEST", 400)
    user_id = g.current_user["id"]
    success = UserStore(get_db()).update(user_id, document_sort_preference=document_sort)
    if not success:
        return api_error("User not found", "NOT_FOUND", 404)
    return jsonify({"status": "updated", "document_sort": document_sort})
