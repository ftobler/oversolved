import type { ConstraintDef, EntityDef } from '@/registry'
import { iconModules } from '@/utils/core/iconModules'

const iconMap = Object.fromEntries(
  Object.entries(iconModules).map(([k, v]) => [k.split('/').pop()?.replace(/\.svg$/, ''), v])
)

export function iconUrl(filename: string): string {
  return iconMap[filename] ?? ''
}

export function shortcutHint(def: ConstraintDef | EntityDef): string {
  return def.shortcut ? ` (${def.shortcut.toUpperCase()})` : ''
}
