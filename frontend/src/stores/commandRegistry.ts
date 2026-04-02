// Central command registry: maps command names to actions registered at runtime.
// Keymaps are defined here so they are testable and independently configurable.

import { CONSTRAINT_SHORTCUTS, ENTITY_SHORTCUTS } from '../registry'

const handlers = new Map<string, () => void>()

// ── Keymap ────
// Key strings are built from KeyboardEvent: optional modifiers joined with '+',
// then the lowercase key name. E.g. Ctrl+Z → "ctrl+z", D → "d".

export type CoreKeybinding = {
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
  { key: 'escape',       command: 'cancel_draw',         label: 'Cancel',              description: 'Cancel active draw or return to select tool' },
]

// Derive the flat key→command record from CORE_KEYBINDINGS.
const CORE_KEYMAP: Record<string, string> =
  Object.fromEntries(CORE_KEYBINDINGS.map(b => [b.key, b.command]))

// Merge core bindings with registry-derived shortcuts
export const KEYMAP: Record<string, string> = {
  ...CORE_KEYMAP,
  ...Object.fromEntries(CONSTRAINT_SHORTCUTS),
  ...Object.fromEntries(ENTITY_SHORTCUTS),
}

// ── Registration ────

export function registerCommand(name: string, fn: () => void): void {
  handlers.set(name, fn)
}

export function unregisterCommand(name: string): void {
  handlers.delete(name)
}

/**
 * Removes every registered handler.
 * Intended for test teardown only — do not call in production code.
 */
export function clearAllHandlers(): void {
  handlers.clear()
}

export function executeCommand(name: string): void {
  handlers.get(name)?.()
}

// ── Key dispatch ────

// Build a canonical key string from a KeyboardEvent, e.g. "ctrl+shift+z" or "delete".
export function buildKeyString(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('ctrl')
  if (e.shiftKey) parts.push('shift')
  if (e.altKey) parts.push('alt')
  parts.push(e.key.toLowerCase())
  return parts.join('+')
}

/**
 * Attempt to dispatch a keyboard event through the keymap.
 * Returns true if the event was handled (caller should call e.preventDefault()).
 * Skips events that originate from input/textarea elements.
 */
export function dispatchKey(e: KeyboardEvent): boolean {
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return false
  const key = buildKeyString(e)
  const cmd = KEYMAP[key]
  if (!cmd) return false
  e.preventDefault()
  executeCommand(cmd)
  return true
}
