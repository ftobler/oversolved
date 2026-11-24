import type { ConstraintDef, EntityDef } from '@/registry'
import { iconUrl } from '@/utils/core/iconUrl'

export { iconUrl }

export function shortcutHint(def: ConstraintDef | EntityDef): string {
  return def.shortcut ? ` (${def.shortcut.toUpperCase()})` : ''
}
