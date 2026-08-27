# Command System Architecture

## Overview

Every user-visible action in the sketch editor is reachable through a central command registry. Toolbar button clicks and keyboard shortcuts go through the same `executeCommand()` code path, enabling headless testing without the DOM.

## Architecture

### Command Registry (`commandRegistry.ts`)

Maps string command names to handler functions registered at runtime.

Core API: `registerCommand(name, fn)`, `unregisterCommand(name)`, `executeCommand(name)`, `buildKeyString(e)`, `dispatchKey(e)`.

`dispatchKey` looks up the event in `KEYMAP` (assembled from `CORE_KEYBINDINGS`, `CONSTRAINT_SHORTCUTS`, `ENTITY_SHORTCUTS`). `FEATURE_KEYMAP` (outside sketch-edit) and `SKETCH_KEYMAP` (inside) hold only genuine mode splits and shadow `KEYMAP`, so a key that means the same thing in both modes belongs in `CORE_KEYBINDINGS`. Keyboard events from INPUT/TEXTAREA elements are skipped.

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

`buildCommandEntries()` creates the full command entry list — single source of truth for which commands are registered during sketch editing. Includes undo, redo, delete, tool activations, constraint applications, cancel commands, and feature commands.

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

All buttons route through `executeCommand(name)` — no direct store calls. Components for entity tools, constraint tools, dimension, drag, rectangles, construction toggle, and reset viewport.

### Click Dispatch (`Viewport/idDispatch/dispatchSketchClick.ts`)

Routes pointer clicks from sketch geometry through the tool registry:
- Gets effective tool from store
- Looks up tool in registry
- Builds `ToolContext` from current state
- Calls `tool.handlers.onClick()` if the active tool has one; otherwise it
  falls back to `state.toggleNormalSelection(id)` (the idle select path).

### Undo/Redo System (`usePartDoc.ts`)

Document-snapshot-based: deep-clones current doc on each mutation, pushes onto undo stack. `handleUndo()` restores saved snapshot. `handleRedo()` re-applies.

Preview system: `startPreviewMode()` suppresses undo entries; `commitPreview()` creates a single undo entry; `cancelPreview()` restores original doc.

All mutation functions are pure operations in `utils/yamlMutations/`. Labels in `mutationDescriptions.ts`.

### Registry Page (`Registry.tsx`)

Static documentation at `/registry` showing all commands, entities, constraints, dimension rules, snaps, measurements, and keybindings. Not interactive.

### Wiring (`Part.tsx`)

Main page: uses `usePartDoc()`, builds command entries via `buildCommandEntries()`, registers via `useCommandRegistration()`, sets callbacks on the sketch editor store.

## Command Families

- **`set_tool_*`** — activate tools (dispatch via shortcuts from `ENTITY_SHORTCUTS` / `CORE_KEYBINDINGS`)
- **`apply_*`** — apply constraints (dispatch via `CONSTRAINT_SHORTCUTS`)
- **Other**: `undo`, `redo`, `delete_selected`, `toggle_construction`, `toggle_sketch_plane_visibility`, `toggle_plane_visibility`, `cancel_draw`, `apply_offset`, `add_extrude`, `add_hole`, `add_transform`

`cancel_draw` is the sketch editor's Escape handler. It is staged, first matching rule wins: a modal or the sketch value dialog owns Escape and it stands down; an open pick field clears the draw and the field; a partially-placed entity (draw points) or a partially-built dimension cancels just that and keeps the tool armed; and with nothing in progress it clears the draw, the pick field and the tool (the historical behaviour). It is not the only Escape listener on `window` (`Dialog.tsx`, `ContextMenuDialog.tsx`, `useRubberBandSelect.ts` and `FeatureTree.tsx` each bind their own), so it stands down whenever a dialog is on screen: any modal built on the `Dialog` shell claims Escape through `utils/core/modalEscape.ts` while it is open, and the sketch value dialog is detected via `pendingDialog`. Each of those closes itself, so one Escape does exactly one thing. Coordinate through that claim, never through listener registration order.

## Keybindings

Active core keys: `ctrl+z` (undo), `ctrl+shift+z`/`ctrl+y` (redo), `delete`/`backspace` (delete), `d` (dimension), `q` (construction toggle), `y` (toggle sketches/planes), `e` (add extrude), `p` (toggle plane visibility), `escape` (cancel).

Constraint shortcuts: `h` (horizontal), `v` (vertical), `c` (coincident), `e` (equal length), `n` (normal), `t` (tangent), `m` (midpoint), `f` (fixed). Parallel is toolbar-only: `p` is owned by plane visibility.

Entity shortcuts: `l` (line), `o` (circle), `a` (arc), `s` (spline), `j` (project).

## Conventions

- Command names: `verb_noun` (e.g. `set_tool_line`, `delete_selected`, `apply_horizontal`)
- Toolbar buttons call `executeCommand(name)`, never a store method directly
- Shortcut hints in tooltips derived from `KEYMAP`, never hardcoded
- `buildKeyString` normalizes Ctrl/Meta → `ctrl`, lowercases, joins with `+`
- Constraint/entity shortcuts auto-merged into `KEYMAP` from registries
