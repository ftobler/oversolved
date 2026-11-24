// The generated icon set, keyed by file stem. The lookup lives under utils so a
// store or a dialog can resolve an icon without importing the component tree
// (the import-boundary test forbids logic roots reaching into components).
import { iconModules } from './iconModules'

const iconMap = Object.fromEntries(
  Object.entries(iconModules).map(([k, v]) => [k.split('/').pop()?.replace(/\.svg$/, ''), v]),
)

export function iconUrl(filename: string): string {
  return iconMap[filename] ?? ''
}
