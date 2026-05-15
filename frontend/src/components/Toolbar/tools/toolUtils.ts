import type { ConstraintDef, EntityDef } from '@/registry'

// Eager-load all icon SVGs so we can look them up by filename at runtime.
const iconModules = import.meta.glob('@/assets/icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

const iconMap = Object.fromEntries(
  Object.entries(iconModules).map(([k, v]) => [k.split('/').pop()?.replace(/\.svg$/, ''), v])
)

export function iconUrl(filename: string): string {
  return iconMap[filename] ?? ''
}

export function shortcutHint(def: ConstraintDef | EntityDef): string {
  return def.shortcut ? ` (${def.shortcut.toUpperCase()})` : ''
}
