# Command System Architecture

## Overview

Every user-visible action in the sketch editor is reachable through a central command registry. Toolbar button clicks and keyboard shortcuts go through the same `executeCommand()` code path, enabling headless testing without the DOM.

## Architecture

### Command Registry (`commandRegistry.ts`)

Maps string command names to handler functions registered at runtime.

Core API: `registerCommand(name, fn)` (returns the unregister function for that handler), `executeCommand(name)`, `buildKeyString(e)`, `dispatchKey(e)`.

`dispatchKey` resolves in order: `ASSEMBLY_KEYMAP` while the assembly editor is active, then `SKETCH_KEYMAP` inside sketch edit, then `FEATURE_KEYMAP` outside it, then `KEYMAP` (assembled from `CORE_KEYBINDINGS`, `CONSTRAINT_SHORTCUTS`, `ENTITY_SHORTCUTS`). `FEATURE_KEYMAP` holds only `e`; `SKETCH_KEYMAP` is currently empty. Both shadow `KEYMAP`, so a key that means the same thing in both modes belongs in `CORE_KEYBINDINGS`. Events from INPUT, TEXTAREA and SELECT elements, contenteditable targets and IME composition are skipped (`isEditableTarget`).

### Constraint Registry (`constraintRegistry.ts`)

Defines all constraint kinds with their `shortcut`, `toolbarIcon`, `refPattern`, `renderKind`, and `category`. Auto-derives `CONSTRAINT_SHORTCUTS` map → `apply_<kind>` command names. Defines dimension rules and helpers.

### Entity Registry (`entityRegistry.ts`)

Defines entity types with `activeTool`, `shortcut`, `toolbarIcon`, `paramCount`, etc. Auto-derives `ENTITY_SHORTCUTS` map → `set_tool_<activeTool>` command names.

### Tool Registry (`toolRegistry.ts`)

Singleton `ToolRegistry` class: `register(tool)`, `get(id)`, `byCategory(category)`, `getToolbarTools()`, `validate()`.

Tools implement `ToolHandlers`: `onPointerDown`, `onPointerMove`, `onPointerUp`, `onPointerOver`, `onPointerOut`, `onClick`.

Tool IDs: `dimension`, `drag`, the entity tools `line`, `circle`, `arc`, `ellipse`, `point`, `project`, `spline`, and the compound drawing tools `rect`, `center_rect`, `ngon`.

Not every interaction is a registered tool:
- **Select** has no registered tool. Idle select is the dispatchSketchClick fallback (`state.toggleNormalSelection(id)` for the clicked entity/vertex) plus the DrawPlane backplane clear on empty-space clicks. The toolbar select button dispatches `set_tool_drag`, and `getEffectiveTool(null)` resolves to `'drag'`.
- **Constraints** have no registered tools. Constraint apply is `apply_<kind>` -> `store.applyConstraint`, which owns the target validation.

### Snap & Measurement Registries (`snapRegistry.ts`, `measurementRegistry.ts`)

Snap rules for drag; measurement rules for on-canvas display.

### Command Entries (`commandEntries.ts`)

`buildCommandEntries()` creates the full command entry list - single source of truth for which commands are registered during sketch editing. Includes undo, redo, delete, tool activations, constraint applications, cancel commands, and feature commands.

### Registration Hook (`useCommandRegistration.ts`)

React effect hook that registers all commands on mount, attaches global `keydown` listener, and tears down on unmount.

### State Store (`sketchEditorStore.ts`)

Zustand store managing selection state (normal, dynamic, hover), drag state, draw state, tool state (`activeTool`, `activeFeatureId`), dialogs, and `onMutation` callback.

### Tool Implementations (`frontend/src/tools/`)

| Tool | File | Behavior |
|---|---|---|
| Drawing | `DrawingTool.ts` | Accumulates draw points, fires `add_entity` mutation |
| Dimension | `DimensionTool.ts` | Two-click flow, resolves dimension kind |
| Drag | `DragTool.ts` | Pointer with threshold detection for vertex drag |

Selection and constraints have no tool implementation: select is the
`dispatchSketchClick` fallback (see below) plus the backplane clear, and
constraints are applied via the `apply_<kind>` commands -> `store.applyConstraint`.

Initialized in `tools/index.ts` via `initializeTools()`.

### Toolbar Components (`frontend/src/components/Toolbar/tools/`)

All buttons route through `executeCommand(name)` - no direct store calls. Components for entity tools, constraint tools, dimension, drag, rectangles, construction toggle, and reset viewport.

### Click Dispatch (`Viewport/idDispatch/dispatchSketchClick.ts`)

Routes pointer clicks from sketch geometry through the tool registry:
- Gets effective tool from store
- Looks up tool in registry
- Builds `ToolContext` from current state
- Calls `tool.handlers.onClick()` if the active tool has one; otherwise it
  falls back to `state.toggleNormalSelection(id)` (the idle select path).

### Undo/Redo

One engine, `History` (`session/History.ts`), capped at `MAX_UNDO_DEPTH = 50`
(`config/undoConfig.ts`). The part editor's `DocSession` owns one; the assembly
editor runs a module-level one (`stores/assemblyHistory.ts`) because a drag's
pointer-up commit runs after the gesture's async solve and must outlive a page
remount.

| | Part editor | Assembly editor |
|---|---|---|
| History owner | `DocSession` (`session/DocSession.ts`), wrapped by `usePartDoc.ts` | the module-level `History<AssemblyDoc>` (`stores/assemblyHistory.ts`), driven by `useAssemblyUndoRedo.ts` |
| Entry | `{ doc, meta: Mutation }` | `{ doc, label: AssemblyUndoLabel }` |
| UI mirror | `partEditorStore`'s undo/redo labels through the adapter | `assemblyStore.undoStack`/`redoStack`, republished by the History |
| Clone | `cloneDocForUndo` (`yamlMutations/undoSnapshot.ts`) | `structuredClone` |
| Writes | `Mutation` values through `session.execute`/`executeGroup` | labelled closures, `mutate(label, fn)` |

- **Part funnel.** `usePartDoc.handleMutation` calls `session.execute(m)`; the
  session clones the doc, runs `mutationHandlers[m.type]` on the clone (the
  appliers in `utils/yamlMutations/` mutate that clone in place), mirrors the
  rollback bar through its injected editor facts when no edit is open, drops
  byte-identical results for the variants `IDEMPOTENT_MUTATION` classifies as
  idempotent (`hooks/mutationIdempotence.ts`, total over the union so a new
  variant cannot be added unclassified), then routes the change through the
  open transactions: a suppressed session swallows it, a live preview swallows
  only its `PREVIEW_SCOPE`, everything else becomes one entry (a pending brep
  projection banks under its dimension commit). `executeGroup` runs several
  mutations on one clone as one entry. Refused transitions are error Results in
  the session; the adapter is the one that voices the pinned `failLoud` text.
- **Transactions.** `session.begin(kind)` opens `preview`/`edit`/`gesture`/`brep`
  work and returns an id; `commit(id)`/`cancel(id)` settle it. Nested or invalid
  transitions return an error Result and record a diagnostic in every
  environment. Cancel restores the doc and the parked history stacks as one
  unit and reconciles the unsaved flag from the pinned `{dirty, saves}` plus the
  save fingerprint. The brep arm/consume/steal and the preview escape live in
  the session's mutation funnel.
- **Undo/redo.** `session.undo()`/`redo()` resolve open work first (bank a
  pending projection, commit a would-push session or preview), move one entry
  across, swap the doc, emit `transactionsDropped` + `historyRestored`, and
  re-solve with any retained pre-delete snapshot. A move whose own commit
  emptied the branch still tears the editor down, because the session knows
  what it just committed. The adapter applies the editor writes on
  `historyRestored` (editing id, pick boundary, clamped rollback, dirty).
- **Snapshot pairing.** `begin('edit')` saves the history snapshot. `cancel`
  rewinds the doc, then restores the snapshot. `commit` clears it.
- **Preview.** `begin('preview')`; mid-session it is refused, so the popover's
  mutations land as session edits (swallowed by a suppressed session,
  per-action in a sketch session). Only the `PREVIEW_SCOPE` appearance
  mutations (`set_part_*`) are swallowed; any other mutation commits the
  preview first. A preview open at session start is resolved with its own entry
  before the session opens. `commit` pushes one entry labelled from the
  part_style diff (an unchanged preview pushes nothing); `cancel` rewinds and
  the adapter returns the restored doc; the caller (`Part.tsx`) closes the
  popover.
- **Edit session.** `begin('edit', { suppressed })`. A suppressed (feature)
  session folds into one `edit_session` entry on commit, only when the doc
  differs (excluding the solve-written `part_style`/`initial` and the pinned
  rollback). A sketch session keeps one entry per action.
- **Markers.** `set_rollback`, `edit_session` and `preview_commit` have no-op appliers in `mutationDispatch.ts`. The rollback is written by the mirror; the other two only label the entry.
- **Assembly.** Edits are not `Mutation` values. `mutate` calls `decideAssemblyMutation` (`noop`, `push` or `fold`). A fold is pinned by `recordSessionEdit`; `commitSession` pushes the pinned pre-session doc as one entry through `History.pushSnapshot`, and `cancelSession` rewinds the doc and leaves the stacks (a pinned session pushed nothing). `mutateOneShot` commits the open session, then pushes its own entry. `applyUndoRedo` commits the open session, moves one entry in the module History, closes the editor and resets transient state before swapping the doc. `assemblyStore`'s stacks are the History's read mirror.
- **Labels.** Part entries are labelled through `describeMutation` (`utils/core/mutationDescriptions.ts`). Assembly labels are `ASSEMBLY_UNDO_LABELS` (`utils/core/assemblyUndoLabels.ts`).

### Registry Page (`Registry.tsx`)

Static documentation at `/registry` showing all commands, entities, constraints, dimension rules, snaps, measurements, and keybindings. Not interactive.

### Wiring (`Part.tsx`)

Main page: uses `usePartDoc()`, builds command entries via `buildCommandEntries()`, registers via `useCommandRegistration()`, sets callbacks on the sketch editor store.

## Command Families

- **`set_tool_*`** - activate tools (dispatch via shortcuts from `ENTITY_SHORTCUTS` / `CORE_KEYBINDINGS`)
- **`apply_*`** - apply constraints (dispatch via `CONSTRAINT_SHORTCUTS`)
- **Other**: `undo`, `redo`, `delete_selected`, `toggle_construction`, `toggle_sketch_plane_visibility`, `toggle_plane_visibility`, `cancel_draw`, `apply_offset`, `add_extrude`, `add_hole`, `add_transform`

`cancel_draw` is the sketch editor's Escape handler. It is staged, first matching rule wins: a modal or the sketch value dialog owns Escape and it stands down; an open pick field clears the draw and the field; a partially-placed entity (draw points) or a partially-built dimension cancels just that and keeps the tool armed; and with nothing in progress it clears the draw, the pick field and the tool (the historical behaviour). It is not the only Escape listener on `window` (`Dialog.tsx`, `ContextMenuDialog.tsx`, `useRubberBandSelect.ts` and `FeatureTree.tsx` each bind their own), so it stands down whenever a dialog is on screen: any modal built on the `Dialog` shell claims Escape through `utils/core/modalEscape.ts` while it is open, and the sketch value dialog is detected via `pendingDialog`. Each of those closes itself, so one Escape does exactly one thing. Coordinate through that claim, never through listener registration order.

## Keybindings

Active core keys: `ctrl+z` (undo), `ctrl+shift+z`/`ctrl+y` (redo), `delete`/`backspace` (delete), `d` (dimension), `shift+m` (mirror), `q` (construction toggle), `y` (toggle sketches/planes), `e` (add extrude, feature mode only), `p` (toggle plane visibility), `escape` (cancel).

Assembly editor keys (`ASSEMBLY_KEYBINDINGS`, active only while the assembly editor is): `ctrl+z`, `ctrl+shift+z`, `delete`, and `escape` (`cancel_edit`, closes the open part or mate editor).

Constraint shortcuts: `h` (horizontal), `v` (vertical), `c` (coincident), `e` (equal length), `n` (normal), `t` (tangent), `m` (midpoint), `f` (fixed). Parallel is toolbar-only: `p` is owned by plane visibility. Inside sketch edit mode `e` is the equal-length constraint; `FEATURE_KEYMAP` restores add-extrude outside a sketch, so `e` is mode dependent.

Entity shortcuts: `l` (line), `o` (circle), `a` (arc), `s` (spline), `j` (project).

## Conventions

- Command names: `verb_noun` (e.g. `set_tool_line`, `delete_selected`, `apply_horizontal`)
- Toolbar buttons call `executeCommand(name)`, never a store method directly
- Shortcut hints in tooltips derived from `KEYMAP`, never hardcoded
- `buildKeyString` normalizes Ctrl/Meta → `ctrl`, lowercases, joins with `+`
- Constraint/entity shortcuts auto-merged into `KEYMAP` from registries
