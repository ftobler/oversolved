// Central command registry: maps command names to actions registered at runtime.
// Keymaps are defined here so they are testable and independently configurable.

import { CONSTRAINT_SHORTCUTS, ENTITY_SHORTCUTS } from '@/registry'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

const handlers = new Map<string, () => void>()

// ─── Keymap ───
// Key strings are built from KeyboardEvent: optional modifiers joined with '+',
// then the lowercase key name. E.g. Ctrl+Z → "ctrl+z", D → "d".

type CoreKeybinding = {
  // Canonical key string, e.g. "ctrl+z".
  key: string
  // Command name, e.g. "undo".
  command: string
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
  { key: 'escape',       command: 'cancel_draw',         label: 'Cancel',              description: 'Cancel active draw or return to select tool' },
]

// Derive the flat key→command record from CORE_KEYBINDINGS.
const CORE_KEYMAP: Record<string, string> =
  Object.fromEntries(CORE_KEYBINDINGS.map(b => [b.key, b.command]))

// Merge core bindings with registry-derived shortcuts.
// Constraint shortcuts take precedence over CORE_KEYBINDINGS (last wins).
export const KEYMAP: Record<string, string> = {
  ...CORE_KEYMAP,
  ...Object.fromEntries(CONSTRAINT_SHORTCUTS),
  ...Object.fromEntries(ENTITY_SHORTCUTS),
}

// Keys that are only active outside of sketch-edit mode.
// These override KEYMAP entries when no sketch is being edited.
// `e` is the only genuine mode split: in a sketch it applies the equal
// constraint, outside one it adds an extrude.
export const FEATURE_KEYMAP: Record<string, string> = {
  'e': 'add_extrude',
}

// Keys that are only active inside sketch-edit mode.
// These take precedence over KEYMAP entries when a sketch is being edited.
// Currently empty: every binding that used to live here behaved the same in both
// modes, so it belongs in CORE_KEYBINDINGS where the Registry page can see it.
// An override here silently shadows KEYMAP, so only add one that really differs.
export const SKETCH_KEYMAP: Record<string, string> = {}

// ─── Registration ───

export function registerCommand(name: string, fn: () => void): void {
  if (import.meta.env.DEV && handlers.has(name)) {
    console.warn(`registerCommand: overwriting existing handler for "${name}"`)
  }
  handlers.set(name, fn)
}

export function unregisterCommand(name: string): void {
  handlers.delete(name)
}

/**
 * Removes every registered handler.
 * Intended for test teardown only, do not call in production code.
 */
export function clearAllHandlers(): void {
  handlers.clear()
}

export function executeCommand(name: string): void {
  handlers.get(name)?.()
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
  const tag = (e.target as HTMLElement)?.tagName
  return tag != null && EDITABLE_TAGS.has(tag)
}

/**
 * Attempt to dispatch a keyboard event through the keymap.
 * Returns true if the event was handled (caller should call e.preventDefault()).
 * Skips events that originate from input/textarea/select elements.
 */
export function dispatchKey(e: KeyboardEvent): boolean {
  if (isEditableTarget(e)) return false
  const key = buildKeyString(e)
  const inSketchEdit = !!useSketchEditorStore.getState().activeFeatureId
  const cmd = (inSketchEdit && SKETCH_KEYMAP[key]) || (!inSketchEdit && FEATURE_KEYMAP[key]) || KEYMAP[key]
  if (!cmd) return false
  e.preventDefault()
  executeCommand(cmd)
  return true
}
