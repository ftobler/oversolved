# Oversolved API

Flask-based REST API for the Oversolved CAD application. The backend is a
document and user store only; all CAD computation runs in the browser via WASM
and never round-trips through these routes.

Every route below was enumerated from the current source: `oversolved/app.py`
(`_register_blueprints`) plus the `@*.route` decorators in
`oversolved/blueprints/*.py`. That inventory is 35 routes across 5 blueprints,
plus static frontend serving defined directly on the app object.

## Architecture

```
oversolved/
├── app.py                  # Flask application factory, config, error handlers, static serving
├── auth.py                 # Token/session authentication helpers
├── config.py               # OversolvedConfig (instance paths, upload dir)
├── rate_limit.py           # In-memory rate limiter used by login
├── db/                     # Database abstraction layer (connection, stores, migrations)
├── migrations/             # Runtime data directory tracking applied migrations
├── cli.py                  # Unified CLI entry point (run_server / db / run_tasks)
├── periodic_tasks.py       # Scheduled cleanup tasks
├── icons.py                # SVG constraint icon generation
├── icon_cairo.py           # Cairo renderer behind icons.py
└── blueprints/
    ├── __init__.py         # Shared decorators: auth_required, api_error, get_db
    ├── auth.py             # /api/auth
    ├── users.py            # /api/users/me
    ├── documents.py        # /api/documents
    ├── upload_export.py    # /api/upload
    └── admin.py            # /api/admin/*, /api/bug-report
```

## Error shape

All errors use one JSON body (`oversolved/blueprints/__init__.py`, `api_error`)
with a matching HTTP status:

```json
{"ok": false, "error": "human readable message", "code": "MACHINE_CODE"}
```

App-level handlers map 400, 404, 405 and 500 to the same shape
(`BAD_REQUEST`, `NOT_FOUND`, `METHOD_NOT_ALLOWED`, `INTERNAL_SERVER_ERROR`).
Unmatched `/api/*` paths return this JSON 404 instead of SPA HTML.

Success responses are plain JSON payloads without an `ok` field.

## Authentication model

Session-based: login sets a `session_token` cookie (httpOnly, SameSite=Lax,
30-day max-age, `Secure` when `SESSION_COOKIE_SECURE` is enabled).

Authenticated routes are wrapped by the `auth_required(...)` composite
decorator, which fixes the check order once for all routes:

1. `require_auth`: valid session cookie for an active user, else 401
   (`UNAUTHORIZED`)
2. `require_csrf`: Origin/Referer must match the request host on non-GET
   requests, else 403 (`CSRF_FAILED`). Exempt: GET/HEAD/OPTIONS and TESTING mode.
3. `require_admin`: `g.current_user.is_admin`, else 403 (`FORBIDDEN`)
4. document permission: view/edit/owner level on `<uuid>`, else 404 if the
   document is missing or 403 if permission is insufficient
5. `require_json`: Content-Type application/json, else 400
   (`INVALID_CONTENT_TYPE`)

Permission levels order as view < edit < owner. Document ownership is what the
owner level checks; public documents grant anonymous-free view access to any
authenticated user through the share machinery.

The three `/api/auth` routes manage the session itself and are gated manually
instead of via `auth_required`.

## Auth: `/api/auth`

- `POST /api/auth/login` - no session required. Body `{credential, password}`
  (`credential` matches username or email). Rate limited to 10 failures per 60s
  per client IP (429 `RATE_LIMITED`). On success returns 200 with
  `{user: {id, username, email, must_change_password, is_admin, is_active,
  last_login_at}}` and sets the session cookie. Wrong credentials answer 401
  `INVALID_CREDENTIALS`; a deactivated account answers 403.
- `POST /api/auth/logout` - CSRF-checked but does not require a valid session.
  Deletes the server-side session row and clears the cookie, returns
  `{status: "logged_out"}`.
- `GET /api/auth/me` - performs its own token check (same gate as
  `require_auth`, so deactivated users are rejected too). Returns
  `{user: {...}}` as above, or 401.

## Users: `/api/users/me`

- `PUT /api/users/me` - update own profile. Body fields all optional:
  `username`, `email`, and password change via `new_password` plus required
  `current_password`. Taken username or email answers 409 `CONFLICT`; wrong
  current password answers 400. Returns `{status: "updated"}`.
- `GET /api/users/me/preferences` - returns `{document_sort}`.
- `PUT /api/users/me/preferences` - body `{document_sort}`, one of
  `alphabetical`, `date_newest_first`, `date_oldest_first`. Returns
  `{status: "updated", document_sort}`.

## Documents: `/api/documents`

All routes require an authenticated session; the per-route minimum document
permission is listed where it applies. Trash entries expire after 30 days.

| Method | Path | Gate | Purpose |
| --- | --- | --- | --- |
| GET | `` | auth | list accessible documents |
| POST | `` | auth + JSON | create |
| GET | `/<uuid>` | view | retrieve with content |
| PUT | `/<uuid>` | edit + JSON | store content |
| PATCH | `/<uuid>` | owner + JSON | rename |
| DELETE | `/<uuid>` | owner | soft delete to trash |
| GET | `/trash` | auth | list trashed documents |
| POST | `/<uuid>/recover` | owner | restore from trash |
| DELETE | `/<uuid>/trash` | owner | permanent delete |
| POST | `/<uuid>/duplicate` | owner | copy with name `"name (Copy)"` |
| POST | `/<uuid>/clone` | view | personal copy of a shared/public doc |
| POST | `/<uuid>/share` | owner + JSON | share with user or make public |
| DELETE | `/<uuid>/share` | view | unshare self, remove user share, or unpublish |
| GET | `/<uuid>/shares` | owner | list shares |
| GET | `/<uuid>/export` | view | raw JSON export |
| GET | `/<uuid>/thumbnail` | view | PNG thumbnail bytes |
| GET | `/<doc_id>/rebuild-stats` | view | solver timing stats |
| POST | `/import` | auth + JSON | import content as new document |

Details worth knowing:

- `GET ""` supports query parameters `sort`, `search`, `include_shared` and
  `filter` (owned/shared/all). List responses omit `preview_image`.
- `POST ""` body `{name, is_public?}` returns 201 `{uuid, name}`.
- `GET /<uuid>` returns `{uuid, name, content, permission, owner_username,
  is_public}` plus base64 `preview_image` when present.
- `PUT /<uuid>` requires a string `content`; optional base64 `preview_image`
  is decoded and size-checked (max 1024x1024) before any write.
- `DELETE /<uuid>` returns `{uuid, status: "moved_to_trash", deleted_at,
  expires_at}`; recovery of an entry older than 30 days answers 410 `GONE`.
- `POST /<uuid>/clone` accepts an optional `{name}` taken verbatim; the default
  name is uniquified against the caller's existing documents.
- `POST /<uuid>/share` body `{username?, permission?}` with permission limited
  to `view` or `edit` (default `view`). An absent `username` key publishes the
  document publicly; a present but blank one is rejected. Returns 201
  `{status: "shared"}`.
- `DELETE /<uuid>/share` allows a viewer to remove their own share at `view`
  level; removing another user's share or toggling public state requires
  ownership (enforced inside the handler). Returns `{status: "unshared"}`.
- `GET /<uuid>/thumbnail` returns `image/png` bytes or an empty 404 body.
- `POST /import` body `{name, content?}` creates a new owned document, returns
  201 `{uuid, name}`.

## Upload: `/api/upload`

- `POST /api/upload` - multipart form with a `file` field, extensions limited
  to `.step`, `.stp`, `.iges`, `.igs`. Saved into the configured upload
  directory under a generated id, returns `{file_id}`.

STEP/IGES geometry import itself runs in the browser (the frontend reads file
bytes directly); this endpoint persists files server-side and is not used by
the current frontend flow.

## Admin: `/api/admin`

All routes require an admin session (plus CSRF on writes).

- `GET /api/admin/users` - `{users: [...]}`.
- `POST /api/admin/users` - body `{username, email, password, is_admin?}`,
  password min length 8. Returns 201 `{id, username, email}`; duplicate
  username or email answers 409.
- `PUT /api/admin/users/<int:user_id>` - partial update of `username`, `email`,
  `is_active`, `is_admin`. An admin cannot deactivate or demote themselves
  (403). Empty update body answers 400.
- `DELETE /api/admin/users/<int:user_id>` - deletes the user; deleting oneself
  answers 403.
- `POST /api/admin/users/<int:user_id>/reset` - body `{password}`, validates
  strength, returns `{status: "reset"}`.
- `GET /api/admin/periodic-tasks` - `{tasks: [...]}`.
- `POST /api/admin/periodic-tasks/<task_key>/run` - force-runs a registered
  task now, returns the task's result JSON.
- `GET /api/admin/backup` - downloads
  `oversolved-backup-YYYY-MM-DD.zip` (as attachment). The archive holds one
  directory per user containing `<doc>.yaml` content files and optional
  `<doc>.png` previews.
- `POST /api/admin/import-backup` - multipart `file` (zip). Guards: 100 MB
  request cap (413), max 10000 entries and max 500 MB decompressed (both 400).
  Creates documents for usernames that exist; unknown users and failed files
  are skipped and reported. Returns `{status: "imported", imported_count,
  skipped_count, errors}` with `errors: null` when empty.

## Bug reports: `/api/bug-report`

- `POST /api/bug-report` - admin only, JSON body. Required `title`; optional
  `description`, `ast`, `selection`, `history`. Writes a markdown report into
  the repository-level `bugreports/` directory and returns 201
  `{status: "saved", filename}`.

## Static frontend serving

`GET /` and `GET /<path>` serve `frontend/dist/` (overridable via the
`FRONTEND_DIST` config key), falling back to `index.html` for SPA routes.
Paths outside the dist root are rejected. Unmatched `api/*` paths return the
JSON 404 error shape instead of HTML.
