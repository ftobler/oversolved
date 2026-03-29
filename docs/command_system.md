# Command System Architecture

## Overview

The goal is to make every user-visible action in the sketch editor reachable through a central command registry, so the editor can be fully tested without touching the UI. Toolbar button clicks and keyboard shortcuts must go through the same code path.

## Architecture

### Command Registry (`frontend/src/stores/commandRegistry.ts`)

Central module that maps string command names → handler functions.

**Core API:**
- `registerCommand(name, fn)` / `unregisterCommand(name)` / `executeCommand(name)`
- `KEYMAP: Record<string, string>` — maps key strings (e.g. `"ctrl+z"`) to command names
- `buildKeyString(e: KeyboardEvent): string` — builds canonical key string from keyboard events
- `dispatchKey(e: KeyboardEvent): boolean` — looks up key in KEYMAP, calls executeCommand

**KEYMAP construction:**
```ts
export const KEYMAP = { ...CORE_KEYMAP, ...Object.fromEntries(CONSTRAINT_SHORTCUTS), ...Object.fromEntries(ENTITY_SHORTCUTS) }
```

### Registries (`frontend/src/registry/`)

**constraintRegistry.ts** — Defines all constraints with:
- `kind` — unique identifier
- `shortcut` — optional keyboard shortcut string
- `toolbarIcon` — icon name
- `showInToolbar` — visibility flag

Exports `CONSTRAINT_SHORTCUTS` — auto-derived Map from shortcut strings to command names. This is the gold standard pattern.

**entityRegistry.ts** — Defines all drawing tools (line, circle, arc, point, rectangle, center_rectangle):
- `activeTool` — tool identifier
- `shortcut` — optional keyboard shortcut string
- `toolbarIcon` — icon name
- `showInToolbar` — visibility flag

Should export `ENTITY_SHORTCUTS` — Map from shortcut strings to command names (mirrors constraint pattern).

Both registries export derived lookup tables (e.g. `TOOLBAR_CONSTRAINTS`, `ENTITY_BY_KIND`) and are tested in `registry/__tests__/registry.test.ts`.

### State Store (`frontend/src/stores/sketchEditorStore.ts`)

Zustand store with actions: `setActiveTool`, `applyConstraint`, `deleteSelected`, `toggleConstruction`, `clearDraw`, `setPlaneSelectionFeatureId`, undo/redo.

### Command Registration (`frontend/src/pages/Part.tsx`)

Currently uses a manual symmetric `registerCommand` / `unregisterCommand` list in a `useEffect` (lines 120–151). Must be refactored to use a loop over a config array to avoid drift.

### Toolbar Components (`frontend/src/components/Toolbar/tools/`)

Currently call store methods directly on click:
- `EntityTools.tsx` — renders entity buttons, calls `setActiveTool` directly
- `ConstraintTools.tsx` — renders constraint buttons, calls `applyConstraint` directly
- `DimensionTool.tsx` — single button, calls `setActiveTool('dimension')`
- `ConstructionToggleTool.tsx` — single button, calls `toggleConstruction`

**Must be refactored** to route through `executeCommand()` instead.

## The Core Problem

Toolbar buttons call store methods directly. Keyboard shortcuts go through `executeCommand()`. These are two separate code paths, so you cannot test toolbar behaviour without mounting React.

## Development Requirements

### Test-Driven Development
- Write failing tests **before** writing implementation code
- Tests live in a `__tests__/` directory adjacent to the module under test
- Pure logic (registry lookups, key building, command dispatch) must have unit tests: happy path, edge cases, invariants
- No mocked store methods where the real Zustand store can be used directly

### ESLint / Static Analysis
- `npm run lint` must pass with zero warnings and errors
- No new `// eslint-disable` suppressions without a comment explaining why
- TypeScript strict mode must remain satisfied — no new `any` casts

### No Regressions
- Full test suite (`npm test`) must stay green
- The Registry page keybindings table must continue to show the complete, up-to-date keymap

### Consistency
- Command names use `verb_noun` convention: `set_tool_line`, `delete_selected`, `apply_horizontal`
- Every toolbar button's `onClick` must call `executeCommand(name)`, never a store method directly
- Shortcut hints in tooltips must be derived from `KEYMAP` or the registry, never hardcoded strings

## Command Families

Commands in the sketch editor fall into two distinct families with different semantics:

**`set_tool_*` — Tool activation commands**
- Activate drawing/selection tools: `set_tool_line`, `set_tool_circle`, `set_tool_arc`, `set_tool_point`, `set_tool_dimension`, `set_tool_select`
- Call `setActiveTool(toolName)` on the store
- Dispatch via keyboard shortcuts from `ENTITY_SHORTCUTS`
- Examples: `'l'` → `set_tool_line`, `'d'` → `set_tool_dimension`

**`apply_*` — Constraint application commands**
- Apply geometric/dimensional constraints to selected entities: `apply_horizontal`, `apply_vertical`, `apply_equal`, etc.
- Call `applyConstraint(constraintKind)` on the store
- Dispatch via keyboard shortcuts from `CONSTRAINT_SHORTCUTS`
- Examples: `'h'` → `apply_horizontal`, `'v'` → `apply_vertical`

**Other commands**
- Utility commands like `undo`, `redo`, `delete_selected`, `toggle_construction`, `cancel_draw`
- Registered manually in `Part.tsx` with stable handler references

## Implementation Tasks

Complete these tasks in order. Each task must have all tests passing before the next begins.

### Task 01 — Write tests for commandRegistry

**File:** `frontend/src/stores/__tests__/commandRegistry.test.ts`

Establish a test baseline for `commandRegistry.ts` before any changes. All functions are pure or nearly pure and must be tested directly (no React or DOM needed).

**Test cases:**

**`buildKeyString(e)`** — Build minimal fake `KeyboardEvent` objects:
- Plain key: `{ key: 'a', ctrlKey: false, ... }` → `"a"`
- Ctrl modifier: `{ ctrlKey: true, key: 'z', ... }` → `"ctrl+z"`
- Ctrl+Shift: `{ ctrlKey: true, shiftKey: true, key: 'z' }` → `"ctrl+shift+z"`
- Meta treated same as Ctrl: `{ metaKey: true, key: 'z' }` → `"ctrl+z"`
- Special keys lowercased: `{ key: 'Delete' }` → `"delete"`
- Alt modifier: `{ altKey: true, key: 'f' }` → `"alt+f"`

**`KEYMAP` completeness:**
- Every value is a non-empty command name string
- Every key matches `buildKeyString` format (lowercase, modifiers joined with `+`)
- No duplicate keys
- Both `CORE_KEYMAP` and `CONSTRAINT_SHORTCUTS`-derived entries present

**`executeCommand` + `registerCommand` + `unregisterCommand`:**
- Registering and executing invokes the handler
- Executing unknown command name does not throw
- After `unregisterCommand`, executing that name does nothing
- Registering same name twice replaces handler (last write wins)

**`dispatchKey`:**
- Returns `false` and does not call handler when `target.tagName === 'INPUT'`
- Returns `false` and does not call handler when `target.tagName === 'TEXTAREA'`
- Returns `false` for a key not in `KEYMAP`
- Returns `true` and calls registered handler for a key in `KEYMAP`
- Does not throw when mapped command has no registered handler
- Calls `e.preventDefault()` on match (verify with spy)

Follow the style of `frontend/src/registry/__tests__/registry.test.ts`: `describe` blocks, plain `it` assertions, no external test helpers beyond vitest.

### Task 02 — Route toolbar buttons through executeCommand

Route every toolbar button's `onClick` through the command system instead of calling store methods directly. This unifies keyboard and mouse code paths.

**New command names:**

| Command name | Action |
|---|---|
| `set_tool_select` | `setActiveTool('select')` |
| `set_tool_line` | `setActiveTool('line')` |
| `set_tool_circle` | `setActiveTool('circle')` |
| `set_tool_arc` | `setActiveTool('arc')` |
| `set_tool_point` | `setActiveTool('point')` |
| `set_tool_rectangle` | `setActiveTool('rectangle')` |
| `set_tool_center_rectangle` | `setActiveTool('center_rectangle')` |
| `set_tool_dimension` | `setActiveTool('dimension')` |
| `toggle_construction` | Already exists — keep it |
| `apply_<kind>` | Already exists for all constraints — keep them |

**Steps:**

1. **Write tests first (TDD):** Add to `commandRegistry.test.ts` or new `toolCommands.test.ts`:
   - Register `set_tool_line` pointing at a spy, call `executeCommand`, assert spy was called
   - Register real handler: `registerCommand('set_tool_line', () => useSketchEditorStore.getState().setActiveTool('line'))`
   - Call `executeCommand('set_tool_line')`, assert `activeTool === 'line'`
   - Write equivalent tests for: `set_tool_circle`, `set_tool_dimension`, `toggle_construction`, one `apply_<constraint>`
   - These tests will fail until Part.tsx registers commands — that's expected

2. **Register commands in Part.tsx:** In the existing `useEffect` (lines 120–151), add registrations for all `set_tool_*` commands

3. **Update toolbar components:**

   **EntityTools.tsx:**
   ```tsx
   // Before:
   onClick={() => setActiveTool(def.activeTool!)}

   // After:
   onClick={() => executeCommand('set_tool_' + def.activeTool)}
   ```
   Remove the `setActiveTool` selector.

   **DimensionTool.tsx:**
   ```tsx
   onClick={() => executeCommand('set_tool_dimension')}
   ```
   Remove the `setActiveTool` selector.

   **ConstraintTools.tsx:**
   ```tsx
   // Before:
   onClick={() => applyConstraint(def.kind)}

   // After:
   onClick={() => executeCommand('apply_' + def.kind)}
   ```
   Remove the `applyConstraint` selector.

   **ConstructionToggleTool.tsx:**
   ```tsx
   onClick={() => executeCommand('toggle_construction')}
   ```
   Remove the `toggleConstruction` selector.

   **RectangleTool.tsx and CenterRectangleTool.tsx:** Use `executeCommand('set_tool_rectangle')` / `executeCommand('set_tool_center_rectangle')`

4. **Verify:** All tests pass, `npm run lint` passes

### Task 03 — Add shortcut field to entityRegistry

Entity tools should support keyboard shortcuts defined in the registry like constraints do. No manual edits to `CORE_KEYMAP` should be needed.

**Steps:**

1. **Write tests first:** Add to `registry/__tests__/registry.test.ts`:
   ```ts
   describe('entityRegistry shortcuts', () => {
     it('every shortcut maps to exactly one entity', () => {
       const shortcuts = ENTITIES.filter(e => e.shortcut).map(e => e.shortcut!)
       expect(new Set(shortcuts).size).toBe(shortcuts.length)
     })

     it('ENTITY_SHORTCUTS derives correct command names', () => {
       for (const e of ENTITIES) {
         if (e.shortcut) {
           expect(ENTITY_SHORTCUTS.get(e.shortcut)).toBe('set_tool_' + e.activeTool)
         }
       }
     })
   })
   ```

2. **Add `shortcut` field to `EntityDef`:** Optional `shortcut?: string` field

3. **Assign shortcuts:** Check `KEYMAP` for conflicts before assigning:
   - Line: `l`
   - Circle: `c`
   - Arc: `a`
   - Point: (optional, none suggested)
   - Rectangle: `r`
   - Center Rectangle: (optional, none suggested)

4. **Export `ENTITY_SHORTCUTS`:** Mirror the pattern from `constraintRegistry.ts`:
   ```ts
   export const ENTITY_SHORTCUTS: ReadonlyMap<string, string> =
     new Map(
       ENTITIES
         .filter(e => e.shortcut)
         .map(e => [e.shortcut!, 'set_tool_' + e.activeTool])
     )
   ```

5. **Merge into KEYMAP:** In `commandRegistry.ts`:
   ```ts
   export const KEYMAP: Record<string, string> = {
     ...CORE_KEYMAP,
     ...Object.fromEntries(CONSTRAINT_SHORTCUTS),
     ...Object.fromEntries(ENTITY_SHORTCUTS),
   }
   ```

6. **Verify Registry page:** New entity shortcuts should appear automatically in the keybindings table

### Task 04 — Auto-register commands from a config array

Replace the manual symmetric `registerCommand` / `unregisterCommand` list in `Part.tsx:120–151` with a loop over a config array.

**Problem:** Every new command requires two matching edits. Missed `unregisterCommand` leaves stale handlers after unmount.

**Steps:**

1. **Write tests first:** Add to new file `frontend/src/pages/__tests__/commandRegistration.test.ts`:
   - Build the command config array directly, verify structure (no duplicates, all names are strings)
   - Verify every name appears in `KEYMAP` OR is a programmatic-only command (e.g. `cancel_plane_selection`)
   - Simulate register → execute → unregister lifecycle with spies

2. **Extract a `useCommandRegistration` hook:** Create `frontend/src/pages/hooks/useCommandRegistration.ts`:
   ```ts
   import { useEffect } from 'react'
   import { registerCommand, unregisterCommand, dispatchKey } from '../stores/commandRegistry'

   export type CommandEntry = { name: string; fn: () => void }

   export function useCommandRegistration(commands: CommandEntry[]): void {
     useEffect(() => {
       for (const { name, fn } of commands) registerCommand(name, fn)
       window.addEventListener('keydown', dispatchKey)
       return () => {
         window.removeEventListener('keydown', dispatchKey)
         for (const { name } of commands) unregisterCommand(name)
       }
     // commands array identity must be stable — caller is responsible for useMemo if needed
     // eslint-disable-next-line react-hooks/exhaustive-deps
     }, commands.map(c => c.fn))
   }
   ```

3. **Refactor Part.tsx:** Replace manual `useEffect` block with `useCommandRegistration` call. Command list must include:
   - `undo`, `redo`, `delete_selected`, `set_tool_dimension`, `toggle_construction`
   - `set_tool_*` commands (from Task 02)
   - `apply_<constraint>` for all shortcut constraints
   - `cancel_draw`, `cancel_plane_selection`

   **Important distinction:** The `'d'` key maps to `set_tool_dimension`, which is a **tool activation** command (from the `set_tool_*` family). This is distinct from constraint application commands (`apply_*`). The dimension tool lets you draw dimension constraints, but activating it is a tool selection, not a constraint application. An earlier draft used `apply_dimension`, but this was corrected to `set_tool_dimension` to accurately reflect its semantics.

4. **Verify:** All tests pass, manual `registerCommand`/`unregisterCommand` calls removed from Part.tsx

### Task 05 — Drive CORE_KEYMAP from a typed config object

Replace the plain `CORE_KEYMAP` string-to-string record with a typed config array so every core keybinding has a label and description. This makes the Registry page keybindings table fully informative and enforces all core command names are defined in one place.

**Steps:**

1. **Write tests first:** Extend `commandRegistry.test.ts`:
   - Every entry in `CORE_KEYBINDINGS` has non-empty `label` and `description` strings
   - `CORE_KEYMAP` derived from `CORE_KEYBINDINGS` produces the same key→command mapping as current hardcoded object

2. **Define `CoreKeybinding` type:**
   ```ts
   export type CoreKeybinding = {
     key: string       // canonical key string, e.g. "ctrl+z"
     command: string   // command name, e.g. "undo"
     label: string     // human-readable name, e.g. "Undo"
     description: string  // short description for Registry page
   }
   ```

3. **Replace `CORE_KEYMAP` with `CORE_KEYBINDINGS`:** Define array with all current entries plus labels/descriptions:
   ```ts
   export const CORE_KEYBINDINGS: readonly CoreKeybinding[] = [
     { key: 'ctrl+z',       command: 'undo',                label: 'Undo',                description: 'Undo the last sketch change' },
     { key: 'ctrl+shift+z', command: 'redo',                label: 'Redo',                description: 'Redo the last undone change' },
     { key: 'ctrl+y',       command: 'redo',                label: 'Redo (alt)',          description: 'Redo the last undone change' },
     { key: 'delete',       command: 'delete_selected',     label: 'Delete',              description: 'Delete selected entities or constraints' },
     { key: 'backspace',    command: 'delete_selected',     label: 'Delete (alt)',        description: 'Delete selected entities or constraints' },
     { key: 'd',            command: 'set_tool_dimension',  label: 'Dimension tool',      description: 'Activate the dimension tool' },
     { key: 'q',            command: 'toggle_construction', label: 'Toggle construction', description: 'Toggle construction mode for selected entities' },
     { key: 'escape',       command: 'cancel_draw',         label: 'Cancel',              description: 'Cancel active draw or return to select tool' },
   ]
   ```

   Derive `CORE_KEYMAP`:
   ```ts
   const CORE_KEYMAP: Record<string, string> =
     Object.fromEntries(CORE_KEYBINDINGS.map(b => [b.key, b.command]))
   ```

4. **Update Registry page:** In `pages/Registry.tsx`, read from `CORE_KEYBINDINGS` for label/description columns. Also show labels from constraint and entity shortcuts.

5. **Update tooltip hints:** DimensionTool and ConstructionToggleTool should derive shortcuts:
   ```ts
   const dimensionKey = CORE_KEYBINDINGS.find(b => b.command === 'set_tool_dimension')?.key
   ```

   Or introduce helper: `getKeyForCommand(command: string): string | undefined` in `commandRegistry.ts` that reverses `KEYMAP`.

   No hardcoded shortcut characters in tooltip strings.

6. **Verify:** All tests pass, `npm run lint` passes, Registry page shows labels and descriptions
