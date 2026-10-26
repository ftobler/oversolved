# Code Guidelines

Comprehensive coding standards for the Oversolved CAD system.

## 1. Project Philosophy

### Test-Driven Development

**Rule:** Write failing tests **before** implementation.

- Tests live in `__tests__/` adjacent to module under test
- Pure logic must have unit tests
- No mocked store methods where Zustand works directly
- Frontend changes must pass `just frontend`
- Python tooling changes must pass `just python`

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

- **Do not** use em-dashes or en-dashes
- **Do not** use emojis in code and documentation

## 3. Persistence

The app is browser-only: there is no server and no database process. Every CAD
computation happens in a WASM Web Worker on the same machine, and documents
live in one of three libraries, one active at a time: IndexedDB under the
origin serving the app (the default), a folder the user picked through the File
System Access API, or that folder's degenerate case, a single opened file. The
pickers are Chromium-only, so on other engines the last two are absent, not
disabled.

**Rule:** Persistence is an implementation detail behind the document store.
Feature code reads and writes documents through the store, never IndexedDB or a
file handle directly. Take the store off `backendBundle`, which holds a
forwarding pair: which library is live is a user choice and it changes at
runtime.

**Rule:** Treat a write as fallible. IndexedDB can reject on quota, on a
private-browsing profile, or on a blocked upgrade; a file write can fail on a
revoked permission or a folder that moved. There is no server copy to fall back
to. Surface the failure rather than dropping the change silently.

## 4. Frontend Conventions

### Command System

**Rule:** A user action that changes the persisted document must go through the
editor's single mutation funnel. An action that changes only transient
interaction state may call the store's own setters directly.

Document mutations, by editor:

- Sketch: toolbar buttons and shortcuts dispatch `executeCommand(name)` into the
  command registry (`frontend/src/utils/core/commandRegistry.ts`), whose specs
  are the static `PART_COMMAND_SPECS` table in
  `frontend/src/pages/commandEntries.ts`. Tool and constraint commands reach the
  document through the sketch store's `onMutation` callback.
- Part: feature and style edits call `handleMutation` (the `usePartDoc`
  adapter), both directly and from the command specs; the adapter forwards
  them to the `DocSession` (`frontend/src/session/`), the framework-free engine
  that owns the doc, history, transactions, dirty policy and solve scheduling.
  The session is the one path that records undo history and triggers a
  re-solve. `PartEditorContext` exposes the same callbacks to the tree.
- Assembly: operations dispatch `executeCommand(name)` through
  `ASSEMBLY_COMMAND_SPECS`, whose specs call `runOperation` into
  `ASSEMBLY_OPERATIONS`. A drag commit writes the doc through the `mutateDoc`
  funnel the page registers on the store. Undo/redo restores the doc through the
  page's own `setDoc` (`useAssemblyUndoRedo.ts`); the stacks live in a
  module-level `History<AssemblyDoc>` (`stores/assemblyHistory.ts`) that
  republishes them into `assemblyStore` as the UI's read mirror.

```tsx
// GOOD - a document mutation through the command path
onClick={() => executeCommand('set_tool_line')}
```

Transient state (hover, selection, the active tool, draw points, drag and gizmo
previews, the rubber band, solver status, an armed pick field, the undo/redo
stacks) describes the interaction rather than the document. It is not persisted
and carries no undo entry, so it is exempt and may use the store's setters or
`useXStore.setState(...)` directly. The undo/redo stacks are engine state with a
store mirror: the part editor's are the `DocSession` history mirrored into
`partEditorStore` by `usePartDoc`, the assembly editor's are the module-level
`History` mirrored into `assemblyStore` by `useAssemblyUndoRedo`. In both cases
the engine is the owner and the store fields are the UI view:

```ts
useAssemblyStore.setState({ manipulation: null, gizmoDrag: null })
```

Do not use a raw `setState` to change `doc`, `features`, `instances`, or any
other persisted-document field; route that through the funnel so undo, redo, and
the save path see it.

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

**Rule:** Read state with selectors and mutate the document through the funnel;
the store's setters are for the transient fields the store itself owns.

```ts
// GOOD - route through executeCommand
onClick={() => executeCommand('apply_horizontal')}
```

**Location:** `frontend/src/stores/editorState.ts` (selection, tool, draw state and the rollback/edit FSM; UI prefs and the value dialog live in `frontend/src/stores/sketchEditorStore.ts`)

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

An ancestry id is one of three roles (`partitionAncestryIds` in
`frontend/src/kernel/queryWire.ts`): a construction UUID `@u|<uuid>` (the
identity), a classifier `@cls_*` (a tie-break), or lineage (everything else).

**Classifiers** (edit-stable tie-break tier; minted `@cls_*` tokens that ride the
ancestry id list, not a separate suffix):
- `@cls_xp`/`@cls_xn`/`@cls_yp`/`@cls_yn`/`@cls_zp`/`@cls_zn` - which end of the
  body AABB an element sits past, per world axis (cardinal/axial)
- `@cls_ld_<lineid>_p|n` - side of a shared bounding line for a sketch surface split
  from a same-ancestry sibling (line division)

See `docs/query.md` for the full resolution tiers.

### Ancestry Lists

**Format:** `?<hex-lengths>;<idA><idB>` where the hex lengths prefix the
concatenated ids.

**Disambiguation:** sibling surfaces sharing ancestry are split by appending the
line-division classifier token to the id list, e.g. `@cls_ld_<lineid>_p` for one
side and `@cls_ld_<lineid>_n` for the other.

## 6. Icon Guidelines

### Drawing in the `oversolved/icons/` package

**Rule:** Use normalized coordinates (0-1), draw with Cairo, regenerate at build time.

```python
@icon("frontend/src/assets/icons/my-icon.svg")
def my_icon(ctx):
    ctx.move_to(0.2, 0.5)
    ctx.line_to(0.8, 0.5)
    stroke(ctx, 2)
    ctx.arc(0.5, 0.5, px(0.1), 0, 2 * math.pi)
    ctx.fill()

draw_all()  # Required at end
```

**Helpers:**
- `px(n)` - convert pixels to normalized coordinates
- `stroke(ctx, width)` - stroke with current color
- `ctx.fill()` - fill closed paths only

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

The full list is `COMMAND_NAMES` (`frontend/src/utils/core/commandNames.ts`);
the tables here name the families. Sketch/part families live in
`PART_COMMAND_SPECS` (`pages/commandEntries.ts`), assembly families in
`ASSEMBLY_COMMAND_SPECS` (`pages/assemblyCommandEntries.ts`). Every command has
a spec with an enabled predicate and a params schema; a command whose values
are user-entered takes them as data and the dialog is only a front end.

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

### Assembly Commands

| Command | Action |
|---------|--------|
| `insert_part_instance` / `add_part` | Open the picker and append a part instance |
| `duplicate_part` / `delete_part` | Duplicate or delete a part instance |
| `set_part_visible` / `set_part_fixed*` | Toggle visibility or the fixed flag |
| `insert_mate_<kind>` / `update_mate` / `delete_mate` | Mate authoring |
| `export_assembly` / `cancel_edit` | Assembly-level actions |

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
- TypeScript strict mode - no new `any` casts

### Test Corpora

Three sibling folder corpora share one loader shape (`recipe.yaml` plus a JSON
manifest) and differ in what makes their expectation true:

- `frontend/oracle/<NN-name>/` - a closed-form `expected.json` (`src/oracle/`).
- `frontend/translations/<NN-name>/` - another tool's `reference.json`
  (`src/translations/`).
- `frontend/regressions/<kebab-name>/` - a real exported document plus a
  readable `checks.json` and optional `snapshot.json` (`src/regressions/`);
  one directory per bug report or real file, no `NN-` order.

### Drive Surface and CLI

- `window.__oversolved` exists in dev/test builds only; it is a test and
  debugging surface, not a product API.
- A document can be driven headlessly with one `DocSession` per operation:
  `npm run drive -- run|commands|measure|compare|export|replay ...` from `frontend/`.
- The same surface (plus `compare`, `measure` and `export`) is served over MCP stdio by
  `npm run mcp`, a hand-rolled JSON-RPC loop with no SDK dependency; the tool
  ops and the CLI share `src/drive/headlessOps.ts`. The MCP server runs the
  kernel in a `worker_threads` worker (`src/drive/kernelHost.ts`,
  `kernelWorker.ts`, `scripts/mcpKernelWorker.ts`) so a stalled solve is
  terminated and reported with the feature it stuck in; `build()` posts the
  per-feature marks from `src/kernel/featureProgress.ts` that re-arm the budget.
- Scripts, the inspect shape, the journal format, the CLI usage and the MCP
  tools are documented in `docs/drive.md`.

## 9. Architecture Patterns

### Command Registry

**Location:** `frontend/src/utils/core/commandSpec.ts` (specs + registry),
`frontend/src/utils/core/commandRegistry.ts` (keymaps + module-level dispatch)

**Core API:**
```ts
interface CommandSpec<Ctx, P> {
  id: CommandName
  label: string
  shortcut?: string
  params: ParamsSpec<P>                       // noParams | valueParam | objectParams
  enabled(ctx: Ctx): true | string            // string is the disabled reason
  run(ctx: Ctx, params: P): CommandResult     // ok (+ createdIds) or an error
  undoable: boolean
}

class CommandRegistry<Ctx> {
  register(spec): () => void                  // identity-guarded unregister
  execute(id, params?): CommandResult         // unknown-command / invalid-params
  enabled(id): true | string
}

// Module level: resolves the active editor's registry (by editor mode).
export function executeCommand(name: CommandName, params?: unknown): CommandResult
export function dispatchKey(e: KeyboardEvent): boolean
export function dispatchKeyOutcome(e: KeyboardEvent): DispatchOutcome
```

Spec tables live in `frontend/src/pages/commandEntries.ts`
(`PART_COMMAND_SPECS`) and `frontend/src/pages/assemblyCommandEntries.ts`
(`ASSEMBLY_COMMAND_SPECS`); pages install them through
`useCommandRegistration(kind, registry, specs)` with a page-built
`CommandContext`. The legacy `registerCommand`/`clearAllHandlers` pair remains
as a fallback seam for tests only.

### Geometry Mapping

**Location:** `frontend/src/utils/geometry/geometryMapping.ts`

- Convert flat array format to UI Sketch format
- Resolve query strings to entity references
- Compute constraint render positions

## 10. Quick Reference

| Task | Command | Location |
|------|---------|----------|
| Session engine rules | `session/DocSession.ts`, `session/History.ts` | `frontend/src/session/` |
| Run Python tooling tests | `pytest tests/` | `tests/` |
| Run frontend tests | `npx vitest run` | `frontend/` |
| Drive a doc headlessly | `npm run drive -- run <script.json>` | `frontend/scripts/driveCli.ts` |
| Serve the drive surface over MCP | `npm run mcp` | `frontend/scripts/mcpServer.ts` |
| Run linter | `npm run lint` | `frontend/` |
| Run type checker | `mypy tests/ oversolved/` | root |
| Add new command | add a `CommandSpec` to the editor's table | `frontend/src/pages/commandEntries.ts` / `assemblyCommandEntries.ts` |
| Add new tool | `frontend/src/registry/entityRegistry.ts` | `frontend/src/registry/` |
| Add new constraint | `frontend/src/registry/constraintRegistry.ts` | `frontend/src/registry/` |
| Add new measurement | `frontend/src/registry/measurementRegistry.ts` | `frontend/src/registry/` |
| Add icon | `@icon()` decorator | `oversolved/icons/` (family module, e.g. `toolbar.py`; launcher is `icons.py`) |
