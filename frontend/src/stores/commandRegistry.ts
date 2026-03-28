// Central command registry: maps command names to actions registered at runtime.
// Keymaps are defined here so they are testable and independently configurable.
// Constraint shortcuts are derived from the constraint registry.

import { CONSTRAINT_SHORTCUTS, CONSTRAINTS } from '../registry'

/** All constraint kinds that have a shortcut, for use in Part.tsx registration. */
export const SHORTCUT_CONSTRAINT_KINDS: readonly string[] =
  CONSTRAINTS.filter(c => c.shortcut).map(c => c.kind)

const handlers = new Map<string, () => void>()

// ── Keymap ─────────────────────────────────────────────────────────────────
// Key strings are built from KeyboardEvent: optional modifiers joined with '+',
// then the lowercase key name. E.g. Ctrl+Z → "ctrl+z", D → "d".

// Core (non-constraint) keybindings
const CORE_KEYMAP: Record<string, string> = {
  'ctrl+z':       'undo',
  'ctrl+shift+z': 'redo',
  'ctrl+y':       'redo',
  'delete':       'delete_selected',
  'backspace':    'delete_selected',
  'd':            'set_tool_dimension',
  'q':            'toggle_construction',
  'escape':       'cancel_draw',
}

// Merge core bindings with constraint-registry-derived shortcuts
export const KEYMAP: Record<string, string> = {
  ...CORE_KEYMAP,
  ...Object.fromEntries(CONSTRAINT_SHORTCUTS),
}

// ── Registration ───────────────────────────────────────────────────────────

export function registerCommand(name: string, fn: () => void): void {
  handlers.set(name, fn)
}

export function unregisterCommand(name: string): void {
  handlers.delete(name)
}

export function executeCommand(name: string): void {
  handlers.get(name)?.()
}

// ── Key dispatch ───────────────────────────────────────────────────────────

/** Build a canonical key string from a KeyboardEvent, e.g. "ctrl+shift+z" or "delete". */
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
