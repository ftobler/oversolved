# Code Guidelines

Comprehensive coding standards for the Oversolved CAD system.

## 1. Project Philosophy

### Test-Driven Development

**Rule:** Write failing tests **before** implementation.

- Tests live in `__tests__/` adjacent to module under test
- Pure logic must have unit tests
- No mocked store methods where Zustand works directly
- Frontend changes must pass `just frontend`
- Backend changes must pass `just backend`

## 2. Code Style

### Commenting

- Use two spaces before inline comments: `x = 1  # comment`
- Comments must describe **intent**, not restate the code
- Do not add banner comments or ASCII-art dividers (e.g. `====`, `----`)
- Keep separators minimal

**Bad:**
```python
# Calculate the length of line segment AB
length = ((A.x - B.x) ** 2 + (A.y - B.y) ** 2) ** 0.5
```

**Good:**
```python
length = distance_between(A, B)
```

### File Size

- Try to keep files shorter than 1k lines
- Split large modules into smaller, focused files

### Character Usage

- **Do not** use em-dashes (—) or en-dashes (–)
- **Do not** use emojis in code and documentation

## 3. Backend Conventions

### Database Usage

**Rule:** Always use context managers for transactions.

```python
with db.transaction():
    cur = db.execute("INSERT INTO features VALUES (?, ?, ?)", ...)
```

- Avoid: "Cannot operate on a closed database"
- Only affects production mode (TESTING config)

### Response Format

**Rule:** Return only newly computed data, not input echo.

```python
# GOOD - only computed result
{
  "geometry": {...}
}
```

## 4. Frontend Conventions

### Command System

**Rule:** All user actions must route through `executeCommand()`.

```tsx
// GOOD - unified command path
onClick={() => executeCommand('set_tool_line')}
```

**Keymap construction** (`frontend/src/utils/core/commandRegistry.ts`):
```ts
// Core bindings are data so the Registry page can render them.
export const CORE_KEYBINDINGS: readonly CoreKeybinding[] = [
  { key: 'ctrl+z', command: 'undo', label: 'Undo', description: '...' },
]

// Derived flat key->command record (module-private).
const CORE_KEYMAP = Object.fromEntries(CORE_KEYBINDINGS.map(b => [b.key, b.command]))

// Constraint shortcuts take precedence over core bindings (last wins).
export const KEYMAP: Record<string, string> = {
  ...CORE_KEYMAP,
  ...Object.fromEntries(CONSTRAINT_SHORTCUTS),
  ...Object.fromEntries(ENTITY_SHORTCUTS),
}
```

### Registry Pattern

**Rule:** Define tools/constraints in registries, derive shortcuts automatically.

```ts
// constraintRegistry.ts
export const CONSTRAINTS: readonly ConstraintDef[] = [
  { kind: 'horizontal', toolbarIcon: 'horizontal', showInToolbar: true },
  { kind: 'vertical', toolbarIcon: 'vertical', showInToolbar: true },
]
```

**Location:** `frontend/src/registry/constraintRegistry.ts`, `frontend/src/registry/entityRegistry.ts`

### State Store

**Rule:** Use Zustand selectors sparingly; prefer command dispatch.

```ts
// GOOD - route through executeCommand
onClick={() => executeCommand('apply_horizontal')}
```

**Location:** `frontend/src/stores/sketchEditorStore.ts`

## 5. Query System

### ID Generation

**Rule:** Generate unique IDs as random base64url (`randomId` in
`frontend/src/utils/yamlMutations/helpers.ts`).

```ts
export function randomId(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}
```

- Features: 18 bytes (24 char base64url)
- Elements: 12 bytes (16 char base64url)

### Query Syntax

**Format:** `$<ELE>`, `@<FEAT>`, `?<hex-lengths>;<ids>[:<TYPE>]`

**Classifiers** (edit-stable tie-break tier; minted `@cls_*` tokens that ride the
ancestry id list, not a separate suffix):
- `@cls_xp`/`@cls_xn`/`@cls_yp`/`@cls_yn`/`@cls_zp`/`@cls_zn` — which end of the
  body AABB an element sits past, per world axis (cardinal/axial)
- `cls_ld_<lineid>_p|n` — side of a shared bounding line for a sketch surface split
  from a same-ancestry sibling (line division)

See `docs/query.md` for the full resolution tiers.

### Ancestry Lists

**Format:** `?<hex-lengths>;<idA><idB>` where the hex lengths prefix the
concatenated ids.

**Disambiguation:** sibling surfaces sharing ancestry are split by appending the
line-division classifier token to the id list, e.g. `@cls_ld_<lineid>_p` for one
side and `@cls_ld_<lineid>_n` for the other.

## 6. Icon Guidelines

### Drawing in `oversolved/icons.py`

**Rule:** Use normalized coordinates (0-1), draw with Cairo, regenerate at build time.

```python
@icon("frontend/src/assets/icons/my-icon.svg")
def my_icon(ctx):
    ctx.move_to(0.2, 0.5)
    ctx.line_to(0.8, 0.5)
    stroke(ctx, 2)
    ctx.arc(0.5, 0.5, px(0.1), 0, 2 * math.pi)
    ctx.fill()

drawall()  # Required at end
```

**Helpers:**
- `px(n)` — convert pixels to normalized coordinates
- `stroke(ctx, width)` — stroke with current color
- `ctx.fill()` — fill closed paths only

**Rules:** (see `docs/icon_guidelines.md` for the full reference)
- `viewBox="0 0 24 24"`
- Size 24×24 px
- Stroke style: `fill="none"` on stroked paths, filled shapes via `ctx.fill()`
- Stroke width: 2 for primary, 1.5 for secondary, 1.0 for accent
- Line joins round, line caps butt (both defaults of the Cairo helpers in
  `oversolved/icon_cairo.py`)
- Color: consistent hardcoded black from the Cairo helpers

**Do not:**
- Set custom colors (the helpers emit black)
- Draw SVG files manually
- Use `ctx.fill()` on open paths

## 7. Command Families

### Tool Activation

| Command | Action |
|---------|--------|
| `set_tool_line` | Activate line drawing tool |
| `set_tool_circle` | Activate circle drawing tool |
| `set_tool_arc` | Activate arc drawing tool |
| `set_tool_point` | Activate point tool |
| `set_tool_dimension` | Activate dimension tool |

### Constraint Application

| Command | Action |
|---------|--------|
| `apply_horizontal` | Constrain to horizontal |
| `apply_vertical` | Constrain to vertical |
| `apply_equal_length` | Equal length constraint |
| `apply_normal` | Normal (perpendicular) constraint |

### Utility Commands

| Command | Action |
|---------|--------|
| `undo` | Undo last change |
| `redo` | Redo undone change |
| `delete_selected` | Delete selected entities |
| `toggle_construction` | Toggle construction mode |
| `cancel_draw` | Cancel active draw operation |

## 8. Test Requirements

### Happy Path + Edge Cases

**Rule:** Test must cover:
1. Happy path
2. Edge cases
3. Invariants

**Example:**
```ts
describe('buildKeyString', () => {
  it('handles plain keys', () => {
    const e = new KeyboardEvent('keydown', { key: 'a' })
    expect(buildKeyString(e)).toBe('a')
  })
})
```

### ESLint Rules

- `npm run lint` must pass with zero warnings/errors
- No new `// eslint-disable` suppressions without explanation
- TypeScript strict mode — no new `any` casts

## 9. Architecture Patterns

### Command Registry

**Location:** `frontend/src/utils/core/commandRegistry.ts`

**Core API:**
```ts
export function registerCommand(name: string, fn: () => void): void
export function executeCommand(name: string): void
export function dispatchKey(e: KeyboardEvent): boolean
```

### Migration System

**Location:** `oversolved/migrations/` (one file per migration, auto-discovered by `discover_and_register()` and applied on startup).

**Rule:** Each migration runs exactly once on startup. Track version in `schema_version` table.

```python
# oversolved/migrations/m002_add_preview_image.py
from oversolved.db import Database

VERSION = 2
NAME = "add_preview_image"


def apply(database: Database) -> None:
    database.execute("ALTER TABLE documents ADD COLUMN preview_image BYTEA")
```

### Geometry Mapping

**Location:** `frontend/src/utils/geometry/geometryMapping.ts`

- Convert flat array format to UI Sketch format
- Resolve query strings to entity references
- Compute constraint render positions

## 10. Quick Reference

| Task | Command | Location |
|------|---------|----------|
| Run backend tests | `pytest tests/` | `tests/` |
| Run frontend tests | `npx vitest run` | `frontend/` |
| Run linter | `npm run lint` | `frontend/` |
| Run type checker | `mypy oversolved/ tests/` | root |
| Add new command | `registerCommand()` | `frontend/src/utils/core/commandRegistry.ts` |
| Add new tool | `frontend/src/registry/entityRegistry.ts` | `frontend/src/registry/` |
| Add new constraint | `frontend/src/registry/constraintRegistry.ts` | `frontend/src/registry/` |
| Add new measurement | `frontend/src/registry/measurementRegistry.ts` | `frontend/src/registry/` |
| Add icon | `@icon()` decorator | `oversolved/icons.py` |
