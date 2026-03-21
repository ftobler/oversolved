// Central command registry: maps command names to actions registered at runtime.
// Keymaps are defined here so they are testable and independently configurable.

const handlers = new Map<string, () => void>()

// ── Keymap ─────────────────────────────────────────────────────────────────
// Key strings are built from KeyboardEvent: optional modifiers joined with '+',
// then the lowercase key name. E.g. Ctrl+Z → "ctrl+z", D → "d".

export const KEYMAP: Record<string, string> = {
  'ctrl+z':       'undo',
  'ctrl+shift+z': 'redo',
  'ctrl+y':       'redo',
  'delete':       'deleteSelected',
  'backspace':    'deleteSelected',
  'd':            'applyDimension',
  'h':            'applyHorizontal',
  'v':            'applyVertical',
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
