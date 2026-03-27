import type { ConstraintDef } from '../../../registry'

// Eager-load all icon SVGs so we can look them up by filename at runtime.
const iconModules = import.meta.glob('../../../assets/icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

export function iconUrl(filename: string): string {
  return iconModules[`../../../assets/icons/${filename}.svg`] ?? ''
}

export function shortcutHint(def: ConstraintDef): string {
  return def.shortcut ? ` (${def.shortcut.toUpperCase()})` : ''
}
