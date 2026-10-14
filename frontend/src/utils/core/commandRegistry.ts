// Central command registry: maps command names to actions registered at runtime.
// Keymaps are defined here so they are testable and independently configurable.

import { CONSTRAINT_SHORTCUTS, ENTITY_SHORTCUTS } from '@/registry'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { useEditorModeStore } from '@/stores/editorModeStore'
import { modalOwnsEscape } from '@/utils/core/modalEscape'
import type { CommandName } from '@/utils/core/commandNames'
import { CommandRegistry, type CommandResult, type CommandTableView } from '@/utils/core/commandSpec'

// The exact event the last dispatch ran a command for. Two co-mounted command
// registrations each attach their own window keydown listener and forward the
// same press here, so the second call must be a no-op rather than replay the
// command. Keying on the event object is narrower than reading `defaultPrevented`:
// an unrelated handler that cancels its own key (PartColorPopover handles Escape)
// also calls preventDefault, and that event was never dispatched through here,
// so it must still reach the command. Only the object this module actually ran a
// command for is skipped.
let lastDispatchedEvent: KeyboardEvent | null = null

// ─── Keymap ───
// Key strings are built from KeyboardEvent: optional modifiers joined with '+',
// then the lowercase key name. E.g. Ctrl+Z → "ctrl+z", D → "d".

type CoreKeybinding = {
  // Canonical key string, e.g. "ctrl+z".
  key: string
  // Command name, e.g. "undo". Checked against COMMAND_NAMES.
  command: CommandName
  // Human-readable label for the Registry page.
  label: string
  // Short description for the Registry page.
  description: string
}

// Core (non-constraint) keybindings with labels and descriptions.
export const CORE_KEYBINDINGS: readonly CoreKeybinding[] = [
  { key: 'ctrl+z',       command: 'undo',                label: 'Undo',                description: 'Undo the last sketch change' },
  { key: 'ctrl+shift+z', command: 'redo',                label: 'Redo',                description: 'Redo the last undone change' },
  { key: 'ctrl+y',       command: 'redo',                label: 'Redo (alt)',           description: 'Redo the last undone change' },
  { key: 'delete',       command: 'delete_selected',     label: 'Delete',              description: 'Delete selected entities or constraints' },
  { key: 'backspace',    command: 'delete_selected',     label: 'Delete (alt)',         description: 'Delete selected entities or constraints' },
  { key: 'd',            command: 'set_tool_dimension',  label: 'Dimension tool',       description: 'Activate the dimension tool' },
  { key: 'q',            command: 'toggle_construction', label: 'Toggle construction',  description: 'Toggle construction mode for selected entities' },
  { key: 'shift+m',      command: 'set_tool_mirror',     label: 'Mirror tool',          description: 'Mirror selected entities across a line' },
  { key: 'y',            command: 'toggle_sketch_plane_visibility', label: 'Toggle sketches/planes', description: 'Hide or show all sketch and plane features' },
  { key: 'e',            command: 'add_extrude',          label: 'Add Extrude',         description: 'Add a new extrude feature (feature mode only)' },
  { key: 'p',            command: 'toggle_plane_visibility', label: 'Toggle planes',    description: 'Hide or show all plane features' },
  { key: 'escape',       command: 'cancel_draw',         label: 'Cancel',              description: 'Cancel the entity being drawn, or release the tool when nothing is in progress' },
]

// Derive the flat key→command record from CORE_KEYBINDINGS.
const CORE_KEYMAP: Record<string, CommandName> =
  Object.fromEntries(CORE_KEYBINDINGS.map(b => [b.key, b.command]))

// Merge core bindings with registry-derived shortcuts.
// Constraint shortcuts take precedence over CORE_KEYBINDINGS (last wins).
export const KEYMAP: Record<string, CommandName> = {
  ...CORE_KEYMAP,
  ...Object.fromEntries(CONSTRAINT_SHORTCUTS),
  ...Object.fromEntries(ENTITY_SHORTCUTS),
}

// Keys that are only active outside of sketch-edit mode.
// These override KEYMAP entries when no sketch is being edited.
// `e` is the only genuine mode split: in a sketch it applies the equal
// constraint, outside one it adds an extrude.
export const FEATURE_KEYMAP: Record<string, CommandName> = {
  'e': 'add_extrude',
}

// Keys that are only active inside sketch-edit mode.
// These take precedence over KEYMAP entries when a sketch is being edited.
// Currently empty: every binding that used to live here behaved the same in both
// modes, so it belongs in CORE_KEYBINDINGS where the Registry page can see it.
// An override here silently shadows KEYMAP, so only add one that really differs.
export const SKETCH_KEYMAP: Record<string, CommandName> = {}

// Assembly keymap, the only table consulted while WorkspacePage says the assembly
// editor is active. It ships the shared keys (undo/redo/delete, including their alt
// bindings, plus Escape to cancel the open edit); no assembly-specific key is
// invented here. Every shared key is listed so this table is the single source
// of what the assembly editor does, rather than a fallthrough to KEYMAP.
//
// Policy: the app default IS the user's workflow default. Whenever a shortcut
// is later requested, it is added here as the new default, and users remain free
// to override it.
export const ASSEMBLY_KEYBINDINGS: readonly CoreKeybinding[] = [
  { key: 'ctrl+z',       command: 'undo',            label: 'Undo',         description: 'Undo the last assembly change' },
  { key: 'ctrl+shift+z', command: 'redo',            label: 'Redo',         description: 'Redo the last undone assembly change' },
  { key: 'ctrl+y',       command: 'redo',            label: 'Redo (alt)',   description: 'Redo the last undone assembly change' },
  { key: 'delete',       command: 'delete_selected', label: 'Delete',       description: 'Delete the selected part or mate' },
  { key: 'backspace',    command: 'delete_selected', label: 'Delete (alt)', description: 'Delete the selected part or mate' },
  { key: 'escape',       command: 'cancel_edit',     label: 'Cancel edit',  description: 'Close the open part or mate editor' },
]

export const ASSEMBLY_KEYMAP: Record<string, CommandName> =
  Object.fromEntries(ASSEMBLY_KEYBINDINGS.map(b => [b.key, b.command]))

// ─── Registry ownership ───

export type EditorKind = 'part' | 'assembly'

// The per-editor registries the mounted editors install. Each editor owns its
// own instance (built by the page from its live CommandContext), so the shared
// names can no longer overwrite each other across editors; module-level
// resolution picks the instance the active editor mode names, exactly as the
// keymap branch below does.
const editorRegistries = new Map<EditorKind, CommandTableView>()

// The compatibility seam for registerCommand: legacy tests and tooling register
// bare callbacks here. Editors never use it; it is consulted only when no
// editor registry is installed, so it cannot shadow a page's specs.
const fallbackRegistry = new CommandRegistry()

export function setEditorCommandRegistry(kind: EditorKind, registry: CommandTableView): void {
  editorRegistries.set(kind, registry)
}

// Identity-guarded, mirroring registerCommand's unregister: an unmount only
// clears the slot while it still holds that mount's own registry.
export function clearEditorCommandRegistry(kind: EditorKind, registry: CommandTableView): void {
  if (editorRegistries.get(kind) === registry) editorRegistries.delete(kind)
}

// Resolve the registry a call belongs to. The active editor mode decides, as
// the keymap branch does; when the mode store has not been told (headless tests
// mount one editor directly) the editor actually mounted is the answer, most
// recent first. With nothing mounted, the compatibility seam answers. A
// fallback shim never shadows a mounted editor's specs.
function resolveRegistry(): CommandTableView {
  const mode = useEditorModeStore.getState().activeEditor
  if (mode === 'assembly') return editorRegistries.get('assembly') ?? fallbackRegistry
  if (mode === 'part') return editorRegistries.get('part') ?? fallbackRegistry
  const mounted = [...editorRegistries.values()]
  return mounted.length > 0 ? mounted[mounted.length - 1] : fallbackRegistry
}

// ─── Compatibility registration ───

// Returns an unregister function bound to this exact callback. It removes the
// entry only while the registry still holds it, so a stale owner (an older
// mount whose name a newer one has since overwritten) cannot remove the newer
// handler. Production editors register specs through CommandRegistry; this
// entry point survives for tests and small tools.
export function registerCommand(name: CommandName, fn: (payload?: unknown) => void): () => void {
  return fallbackRegistry.register(CommandRegistry.legacySpec(name, fn))
}

/**
 * Removes every handler registered through registerCommand.
 * Intended for test teardown only, do not call in production code.
 */
export function clearAllHandlers(): void {
  fallbackRegistry.clear()
}

// Runs a command through the registry the active editor installed and returns
// its Result; an unknown id is an error Result (and a dev warning, because a
// keymap entry that resolves to nothing is a registration gap).
export function executeCommand(name: CommandName, params?: unknown): CommandResult {
  const registry = resolveRegistry()
  if (import.meta.env.DEV && !registry.has(name)) {
    console.warn(`executeCommand: no handler registered for "${name}"`)
  }
  return registry.execute(name, params)
}

// ─── Key dispatch ───

// Build a canonical key string from a KeyboardEvent, e.g. "ctrl+shift+z" or "delete".
export function buildKeyString(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('ctrl')
  if (e.shiftKey) parts.push('shift')
  if (e.altKey) parts.push('alt')
  parts.push(e.key.toLowerCase())
  return parts.join('+')
}

// Focusable controls that own their keystrokes: typing in these must never
// trigger document-level commands (undo, tools, constraints).
const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/**
 * True when a keydown should not trigger document-level commands: the event
 * targets an interactive/editable control, or it is an IME composition event
 * whose key is not yet a final character. Central place to extend the guard
 * for any future interactive control.
 */
export function isEditableTarget(e: KeyboardEvent): boolean {
  if (e.isComposing) return true
  if (e.key === 'Unidentified') return true
  // contenteditable is a property, not a tag: a plain <div contenteditable>
  // would otherwise reach the document commands, so Ctrl+Z inside it would fire
  // a document undo instead of the browser's native text undo.
  const target = e.target as HTMLElement | null
  if (target?.isContentEditable) return true
  return target?.tagName != null && EDITABLE_TAGS.has(target.tagName)
}

// What a keydown resolved to: whether the event was consumed, and the Result
// for callers that want to inspect it.
export interface DispatchOutcome {
  handled: boolean
  result?: CommandResult
}

/**
 * Attempt to dispatch a keyboard event through the keymap.
 * Returns the outcome; `handled` true means the caller should consider the
 * event consumed (dispatchKey below is the boolean wrapper).
 * Skips events that originate from input/textarea/select elements.
 */
export function dispatchKeyOutcome(e: KeyboardEvent): DispatchOutcome {
  // Idempotent per event. Each mounted command registration attaches its own
  // window keydown listener and forwards to here, so two co-mounted editors
  // deliver one press twice and both resolve the same registry. The
  // once-per-event guard is the identity of the event this module already ran a
  // command for, not `defaultPrevented`: any other handler may cancel a key for
  // its own reasons (a non-modal popover's Escape), and that event must still
  // reach its command. No single-listener path changes.
  if (e === lastDispatchedEvent) return { handled: false }
  if (isEditableTarget(e)) return { handled: false }
  // A modal owns the keyboard while it is on screen: focus often sits on a
  // non-input control (a dialog button), so document-level commands would
  // otherwise fire behind it. Stand down for every key, not just Escape.
  if (modalOwnsEscape()) return { handled: false }
  const key = buildKeyString(e)
  const inAssembly = useEditorModeStore.getState().activeEditor === 'assembly'
  const inSketchEdit = !!useSketchEditorStore.getState().activeFeatureId
  // Assembly mode resolves only through ASSEMBLY_KEYMAP: a key it does not list
  // is inert there, never a sketch command. Outside assembly, the sketch/feature
  // split applies, then the merged KEYMAP.
  let cmd: CommandName | undefined
  if (inAssembly) {
    cmd = ASSEMBLY_KEYMAP[key]
  } else {
    cmd = (inSketchEdit && SKETCH_KEYMAP[key]) || (!inSketchEdit && FEATURE_KEYMAP[key]) || KEYMAP[key]
  }
  if (!cmd) return { handled: false }
  // A keymap entry with no registered spec is a registration gap, i.e. a bug:
  // surface it and let the browser default apply rather than eating the
  // keystroke silently. The registered path is unchanged.
  const registry = resolveRegistry()
  if (!registry.has(cmd)) {
    if (import.meta.env.DEV) console.warn(`dispatchKey: no handler registered for "${cmd}"`)
    return { handled: false }
  }
  e.preventDefault()
  lastDispatchedEvent = e
  return { handled: true, result: registry.execute(cmd) }
}

/**
 * Boolean view of dispatchKeyOutcome for the common listener path.
 * Returns true if the event was handled.
 */
export function dispatchKey(e: KeyboardEvent): boolean {
  return dispatchKeyOutcome(e).handled
}
