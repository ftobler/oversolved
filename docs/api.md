# Oversolved API

Flask-based REST + WebSocket API for the Oversolved CAD application.

## Architecture

```
oversolved/
├── app.py                  # Flask application factory and config
├── db.py                   # Database abstraction layer + migrations
├── run_server.py           # CLI entry point
├── periodic_tasks.py       # Scheduled cleanup tasks
├── blueprints/
│   ├── auth.py             # Authentication endpoints
│   ├── users.py            # User profile/preferences endpoints
│   ├── documents.py        # Document CRUD endpoints
│   ├── upload_export.py    # Import/export endpoints
│   ├── admin.py            # Admin endpoints
│   ├── docs.py             # Documentation serving
│   └── solver_ws.py        # WebSocket solver endpoint
└── kernel/                 # CAD solver engine (no Flask dependency)
    ├── solver.py           # Main solver orchestrator
    ├── builder.py          # AST-based document builder
    ├── geometry.py         # Mesh tessellation (solid_to_mesh)
    ├── cadquery_ops.py     # CadQuery wrapper operations
    ├── topology.py         # B-rep topology helpers
    ├── query.py            # Feature/entity query resolution
    └── types3d.py          # Core data types
```

## Authentication

Session-based (cookie `session_token`, httpOnly, SameSite=Lax, 30-day max-age).

- `POST /api/auth/login` — `{credential, password}` → user object + cookie
- `POST /api/auth/logout` — destroy session
- `GET /api/auth/me` — current user

## Documents

All require auth.

- `GET /api/documents` — list accessible docs (`?sort=`, `?search=`, `?include_shared=`, `?filter=`)
- `POST /api/documents` — create doc `{name}`
- `GET /api/documents/<uuid>` — retrieve doc with content, permission, owner
- `PUT /api/documents/<uuid>` — store content `{content, preview_image?}`
- `PATCH /api/documents/<uuid>` — rename (owner only)
- `DELETE /api/documents/<uuid>` — soft-delete to trash (expires 30d)
- `GET /api/documents/trash` — list trashed docs
- `POST /api/documents/<uuid>/recover` — restore from trash
- `DELETE /api/documents/<uuid>/trash` — permanent delete
- `POST /api/documents/<uuid>/duplicate` — copy (owner only)
- `POST /api/documents/<uuid>/clone` — personal copy of shared/public doc
- `POST /api/documents/<uuid>/share` — share with user `{username, permission}` or omit username for public
- `DELETE /api/documents/<uuid>/share` — remove share `{username?}`
- `GET /api/documents/<uuid>/shares` — list shares (owner only)
- `GET /api/documents/<uuid>/export` — raw JSON export
- `GET /api/documents/<uuid>/thumbnail` — PNG thumbnail bytes
- `GET /api/documents/<uuid>/rebuild-stats` — solver timing stats
- `POST /api/documents/import` — import `{name, content}`

## Users

- `PUT /api/users/me` — update profile/password
- `GET /api/users/me/preferences` — get prefs (e.g. `document_sort`)
- `PUT /api/users/me/preferences` — update prefs

## Solver (WebSocket)

`WS /api/solver-ws` — connect with `?token=<session_token>` or cookie. Rate limit 10 auth failures/min/IP.

Text JSON messages from client, text JSON + binary geometry frames from server.

Client messages: `solve` (with features + options), `clear_cache`, `ping`.

Each `solve` produces: (1) JSON `solve_result` with per-feature status, (2) binary frame with geometry data.

## Import / Export

- `POST /api/upload` — upload .step/.stp/.iges/.igs (multipart)
- `POST /api/export/step` — export as STEP `{features, body_id?}`
- `POST /api/export/stl` — export as STL `{features, body_id?, deflection?, angular_deflection?}`

## Admin (require admin)

- `GET /api/admin/users` — list users
- `POST /api/admin/users` — create user
- `PUT /api/admin/users/<id>` — update user
- `DELETE /api/admin/users/<id>` — delete user
- `POST /api/admin/users/<id>/reset` — reset password
- `GET /api/admin/periodic-tasks` — list tasks
- `POST /api/admin/periodic-tasks/<key>/run` — run task now
- `GET /api/admin/backup` — download ZIP backup
- `POST /api/admin/import-backup` — import backup ZIP

## Misc

- `POST /api/bug-report` — submit bug report
- `GET /api/docs` — list available docs
- `GET /api/docs/<name>` — get doc markdown
- `GET /` + `GET /<path>` — serve frontend from `frontend/dist/`
