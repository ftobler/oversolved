# Command System Architecture

## Overview

Every named user action is a `CommandSpec` with metadata, a runtime-checked
params schema, an `enabled` predicate and a `run` body that returns a `Result`
with the ids it created. Both editors register their spec table on a
`CommandRegistry` instance the page owns; toolbar clicks, keyboard shortcuts
and programmatic `executeCommand()` calls all resolve through the registry the
active editor installed, so the whole table is testable headlessly without the
DOM. Programmatic calls never open dialogs: a command that needs values takes
them as data, and the dialog is a front end that parses the input and calls
`execute`.

## Architecture

### Command Specs (`utils/core/commandSpec.ts`)

`CommandSpec<Ctx, P>` carries:

- `id`: a `CommandName` from the closed union in `utils/core/commandNames.ts`.
- `label`, `shortcut?`, `undoable`: docs and Registry metadata.
- `params`: a lightweight runtime schema (`noParams()`, `valueParam(field)`,
  `objectParams({...})` with `Field.string/number/boolean/nullableString/any/object`).
  `parse(raw)` returns `{ ok: true, value }` or `{ ok: false, error }`; the
  registry reports a failed parse as an `invalid-params` Result and never calls
  the body.
- `enabled(ctx)`: `true` or the reason it cannot run; toolbars render the
  reason as the disabled state.
- `run(ctx, params)`: returns a `Result` (ok plus created ids, or an error).

`CommandRegistry<Ctx>` is an instance, not a module-level map. `register(spec)`
returns an identity-guarded unregister, `execute(id, params?)` returns a
`CommandResult` (`unknown-command` for an id with no spec, `invalid-params` for
a payload that misses the schema), and `enabled(id)` reads the live context.
`CommandTableView` is the context-free view of a registry that module-level
dispatch and the toolbar React context hold.

### Registries and dispatch (`commandRegistry.ts`)

Each mounted page builds one `CommandContext` (the session plus the page's
action callbacks for the part editor; the operation host plus UI side effects
for the assembly editor) and one registry around it, and installs the registry
for its editor kind. `resolveRegistry()` picks the registry the active editor
mode names (falling back to the single mounted editor), so the three shared
names (`undo`, `redo`, `delete_selected`) live in both tables without
last-mount-wins.

`executeCommand(name, params?)` resolves that registry and returns its Result;
an unknown id is an error Result and a dev warning. `dispatchKey(e)` resolves
the keymap exactly as before (`ASSEMBLY_KEYMAP` while the assembly editor is
active, then `SKETCH_KEYMAP`/`FEATURE_KEYMAP`/`KEYMAP`) and runs the resolved
command through the same registry; `dispatchKeyOutcome(e)` additionally returns
the Result. The legacy `registerCommand(name, fn)` entry point still registers
a bare callback on the fallback registry (tests and small tools only; it never
shadows a mounted editor's specs).

`buildKeyString`, `isEditableTarget` and the keymaps are unchanged.
`buildKeyString` normalizes Ctrl/Meta to `ctrl`, lowercases and joins with `+`;
events from INPUT, TEXTAREA and SELECT elements, contenteditable targets and
IME composition are skipped (`isEditableTarget`).

### The Execution Seam Outside the UI

The registry instance is the one seam every user action passes (toolbar,
keymap, module-level `executeCommand`), so two external surfaces hang off the
same instance in development and test builds:

- A journaling subclass records every doc-changing command for repro replay.
- The page installs `window.__oversolved` over the same instance, exposing
  `commands()`/`execute()`/`script()` plus `inspect()`.

The headless CLI drives the same spec table through a `DocSession` in node.
All three are documented in `docs/drive.md`.

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

### Command Tables (`commandEntries.ts`, `assemblyCommandEntries.ts`)

`PART_COMMAND_SPECS` (the sketch/part editor, 45 specs) and
`ASSEMBLY_COMMAND_SPECS` (the assembly editor, 29 specs) are the single source
of truth for which commands each editor registers. Both are static data: every
body reads its inputs from the `CommandContext` it is handed, so the table is
enumerable headlessly. The three shared names (`undo`, `redo`,
`delete_selected`) appear in both tables and resolve per active editor.

Part specs read the page through `PartCommandContext`: `session` (undo/redo
availability and created ids), `state()` (the live L2 editor state plus the
sketch UI store), the page callbacks (`undo`, `redo`, `deleteSelectedFeatures`,
the two visibility toggles, `addFeature`, `showMessage`). `addFeature` returns
the session Result, which is how `add_extrude`/`add_hole`/`add_transform`
report created ids. `apply_offset` takes `{ distance }`; `openOffsetDialog()` is
the toolbar's front end that collects the number and calls
`executeCommand('apply_offset', { distance })`.

Assembly specs read `AssemblyCommandContext`: `runOperation` (typed per
operation), the store's one `deleteSubject`, the UI side effects
(`openInsertPart`, `openExport`, `onMateInserted`) and the store-backed
`undoDepth`/`redoDepth`. The former `payload as never` cast in the page is gone:
each spec parses its params and the operation receives a typed input.

### Registration Hook (`useCommandRegistration.ts`)

React effect hook: installs the page's registry as its editor kind's table (for
module-level `executeCommand`), registers the spec list on mount, attaches the
global `keydown` listener and tears all of it down on unmount. Contract: the
spec list has a stable length (pass a module-level table); a development-only
effect reports a length change.

### State Stores (`stores/editorState.ts` + `stores/sketchEditorStore.ts`)

`stores/editorState.ts` is the L2 editor-state store (vanilla zustand, no React; its React binding is `hooks/useEditorState.ts`). It owns selection (normal, dynamic, hover), drag/draw state, tool state (`activeTool`, `activeFeatureId`, `activePickField`), the part rollback/edit FSM (`rollbackPosition`, `pickBoundary`, `editingFeatureId`) and the derived non-solve viewport fields (`ghostMode`, `partColors`, `partStyle`, `activeSketchFeatureId`). `sketchEditorStore.ts` keeps the UI-facing remainder (prefs, the pending value dialog, the context menu) as `useSketchUiStore` and re-exports the editor-state hook under its historical name `useSketchEditorStore`. Solve results, bodies, timings and validation are session/solver facts and live in `stores/partEditorStore.ts`.

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

Tool and constraint buttons route through `executeCommand(name)` - no direct
store calls. Components for entity tools, constraint tools, dimension, drag,
rectangles, construction toggle, and reset viewport. Not every toolbar-family
button is a command: the feature-panel add buttons (`PartEditorPanel`) call the
page's handlers directly, the reset-viewport button calls the viewport handle,
and the sketch toolbar's mirror/offset buttons read their disabled state from
the command registry (via the toolbar React context) and run through it.

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

Static documentation at `/registry` showing all commands, entities, constraints, dimension rules, snaps, measurements, and keybindings. Not interactive. The commands table and the generated block below both come from `pages/registry/commandRows.ts`, which derives them from the spec tables, so a spec change is a Registry change (and a docs regeneration).

### Wiring (`Part.tsx`)

Main page: uses `usePartDoc()`, builds a `PartCommandContext` around the session and its callbacks, creates one `CommandRegistry` via `useCommandRegistryWithContext`, and installs/registers it via `usePartCommands` -> `useCommandRegistration('part', registry, PART_COMMAND_SPECS)`. `AssemblyEditor.tsx` does the same for `ASSEMBLY_COMMAND_SPECS`.

## Command Families

- **`set_tool_*`** - activate tools (dispatch via shortcuts from `ENTITY_SHORTCUTS` / `CORE_KEYBINDINGS`)
- **`apply_*`** - apply constraints (dispatch via `CONSTRAINT_SHORTCUTS`)
- **Other**: `undo`, `redo`, `delete_selected`, `toggle_construction`, `toggle_sketch_plane_visibility`, `toggle_plane_visibility`, `cancel_draw`, `apply_offset`, `add_extrude`, `add_hole`, `add_transform`

`cancel_draw` is the sketch editor's Escape handler. It is staged, first matching rule wins: a modal or the sketch value dialog owns Escape and it stands down; an open pick field clears the draw and the field; a partially-placed entity (draw points) or a partially-built dimension cancels just that and keeps the tool armed; and with nothing in progress it clears the draw, the pick field and the tool (the historical behaviour). It is not the only Escape listener on `window` (`Dialog.tsx`, `ContextMenuDialog.tsx`, `useRubberBandSelect.ts` and `FeatureTree.tsx` each bind their own), so it stands down whenever a dialog is on screen: any modal built on the `Dialog` shell claims Escape through `utils/core/modalEscape.ts` while it is open, and the sketch value dialog is detected via `pendingDialog`. Each of those closes itself, so one Escape does exactly one thing. Coordinate through that claim, never through listener registration order.

## Commands

Every command in the closed `COMMAND_NAMES` union, generated from the two spec
tables (`pages/registry/commandRows.ts`). `Undo` marks commands whose run may
push an undo entry; `Editor` names which editor registers the spec (`any` for
the three shared names). Regenerate with `npm run docs:commands`;
`commandDocs.test.ts` fails with a diff when this block is stale.

<!-- command-table:start -->

| Command | Label | Shortcut | Undo | Editor |
|---|---|---|---|---|
| `add_extrude` | Add extrude | `e` | yes | sketch/part |
| `add_hole` | Add hole | - | yes | sketch/part |
| `add_part` | Add part | - | yes | assembly |
| `add_transform` | Add transform | - | yes | sketch/part |
| `apply_angle` | Apply Angle | - | yes | sketch/part |
| `apply_coincident` | Apply Coincident | `c` | yes | sketch/part |
| `apply_colinear` | Apply Colinear | - | yes | sketch/part |
| `apply_concentric` | Apply Concentric | - | yes | sketch/part |
| `apply_diameter` | Apply Diameter | - | yes | sketch/part |
| `apply_equal_length` | Apply Equal | `e` | yes | sketch/part |
| `apply_fixed` | Apply Fixed | `f` | yes | sketch/part |
| `apply_horizontal` | Apply Horizontal | `h` | yes | sketch/part |
| `apply_length` | Apply Length | - | yes | sketch/part |
| `apply_line_distance` | Apply Line Distance | - | yes | sketch/part |
| `apply_midpoint` | Apply Midpoint | `m` | yes | sketch/part |
| `apply_normal` | Apply Normal | `n` | yes | sketch/part |
| `apply_offset` | Offset selection | - | yes | sketch/part |
| `apply_parallel` | Apply Parallel | - | yes | sketch/part |
| `apply_point_distance` | Apply Point Distance | - | yes | sketch/part |
| `apply_point_distance_x` | Apply Horizontal Point Distance | - | yes | sketch/part |
| `apply_point_distance_y` | Apply Vertical Point Distance | - | yes | sketch/part |
| `apply_radius` | Apply Radius | - | yes | sketch/part |
| `apply_radius_difference` | Apply Radius Difference | - | yes | sketch/part |
| `apply_tangent` | Apply Tangent | `t` | yes | sketch/part |
| `apply_vertical` | Apply Vertical | `v` | yes | sketch/part |
| `cancel_draw` | Cancel | `escape` | no | sketch/part |
| `cancel_edit` | Cancel edit | `escape` | no | assembly |
| `delete_mate` | Delete mate | - | yes | assembly |
| `delete_part` | Delete part | - | yes | assembly |
| `delete_selected` | Delete selection | `delete` | yes | any |
| `duplicate_part` | Duplicate part | - | yes | assembly |
| `export_assembly` | Export assembly | - | no | assembly |
| `insert_mate_copy_rotation` | Insert Copy rotation mate | - | yes | assembly |
| `insert_mate_fixed` | Insert Fixed mate | - | yes | assembly |
| `insert_mate_parallel` | Insert Parallel mate | - | yes | assembly |
| `insert_mate_parallel_plane_distance` | Insert Parallel at distance mate | - | yes | assembly |
| `insert_mate_rotating` | Insert Rotating mate | - | yes | assembly |
| `insert_mate_sliding` | Insert Sliding mate | - | yes | assembly |
| `insert_mate_sliding_rotating` | Insert Sliding + Rotating mate | - | yes | assembly |
| `insert_mate_spherical` | Insert Spherical mate | - | yes | assembly |
| `insert_mate_tangential` | Insert Tangential mate | - | yes | assembly |
| `insert_part_instance` | Insert part | - | no | assembly |
| `redo` | Redo | `ctrl+shift+z` | no | any |
| `rename_mate` | Rename mate | - | yes | assembly |
| `reorder_mate` | Reorder mate | - | yes | assembly |
| `reorder_part` | Reorder part | - | yes | assembly |
| `set_builtin_visible` | Set builtin visibility | - | yes | assembly |
| `set_part_fixed` | Fix part | - | yes | assembly |
| `set_part_fixed_oneshot` | Fix part (one-shot) | - | yes | assembly |
| `set_part_position` | Set part position | - | yes | assembly |
| `set_part_rotation` | Set part rotation | - | yes | assembly |
| `set_part_visible` | Set part visibility | - | yes | assembly |
| `set_tool_arc` | Arc tool | `a` | no | sketch/part |
| `set_tool_center_rect` | Center rectangle tool | - | no | sketch/part |
| `set_tool_circle` | Circle tool | `o` | no | sketch/part |
| `set_tool_dimension` | Dimension tool | `d` | no | sketch/part |
| `set_tool_drag` | Drag tool | - | no | sketch/part |
| `set_tool_ellipse` | Ellipse tool | - | no | sketch/part |
| `set_tool_line` | Line tool | `l` | no | sketch/part |
| `set_tool_mirror` | Mirror tool | `shift+m` | no | sketch/part |
| `set_tool_ngon` | N-gon tool | - | no | sketch/part |
| `set_tool_point` | Point tool | - | no | sketch/part |
| `set_tool_project` | Project tool | `j` | no | sketch/part |
| `set_tool_rect` | Rectangle tool | - | no | sketch/part |
| `set_tool_select` | Select tool | - | no | sketch/part |
| `set_tool_spline` | Spline tool | `s` | no | sketch/part |
| `toggle_construction` | Toggle construction | `q` | yes | sketch/part |
| `toggle_plane_visibility` | Toggle planes | `p` | yes | sketch/part |
| `toggle_sketch_plane_visibility` | Toggle sketches/planes | `y` | yes | sketch/part |
| `undo` | Undo | `ctrl+z` | no | any |
| `update_mate` | Update mate | - | yes | assembly |

<!-- command-table:end -->

## Keybindings

Active core keys: `ctrl+z` (undo), `ctrl+shift+z`/`ctrl+y` (redo), `delete`/`backspace` (delete), `d` (dimension), `shift+m` (mirror), `q` (construction toggle), `y` (toggle sketches/planes), `e` (add extrude, feature mode only), `p` (toggle plane visibility), `escape` (cancel).

Assembly editor keys (`ASSEMBLY_KEYBINDINGS`, active only while the assembly editor is): `ctrl+z`, `ctrl+shift+z`/`ctrl+y` (undo/redo), `delete`/`backspace` (delete the selected part or mate), and `escape` (`cancel_edit`, closes the open part or mate editor).

Constraint shortcuts: `h` (horizontal), `v` (vertical), `c` (coincident), `e` (equal length), `n` (normal), `t` (tangent), `m` (midpoint), `f` (fixed). Parallel is toolbar-only: `p` is owned by plane visibility. Inside sketch edit mode `e` is the equal-length constraint; `FEATURE_KEYMAP` restores add-extrude outside a sketch, so `e` is mode dependent.

Entity shortcuts: `l` (line), `o` (circle), `a` (arc), `s` (spline), `j` (project).

## Conventions

- Command names: `verb_noun` (e.g. `set_tool_line`, `delete_selected`, `apply_horizontal`)
- Toolbar buttons execute through the command registry (module-level `executeCommand(name)` or the page's injected registry), never a store method directly
- Programmatic execution takes values as parsed params; dialogs are front ends that call execute
- Shortcut hints in tooltips derived from `KEYMAP`, never hardcoded
- Constraint/entity shortcuts auto-merged into `KEYMAP` from registries
