import { getDimCallbacks } from './dimensionLabelCallbacks'

/**
 * Decode a `dimensionLabel` ID-layer entity key into its constraint id.
 * Shape: `dim:<cid>` or `dim:<cid>:<sub>`. The sub key (e.g. `value-1`)
 * exists so a two-radius dimension can register two hit circles under
 * the same constraint; both route to the same dispatch.
 */
export function parseDimensionLabelKey(entityKey: string): { cid: string; sub?: string } | null {
  if (!entityKey.startsWith('dim:')) return null
  const rest = entityKey.slice(4)
  if (rest.length === 0) return null
  const colon = rest.indexOf(':')
  if (colon < 0) return { cid: rest }
  return { cid: rest.slice(0, colon), sub: rest.slice(colon + 1) }
}

/**
 * Per-event dispatchers. Each returns true if it handled the hit (so the
 * caller can skip further routing) or false if there was no matching
 * registered handler.
 */
export const dimensionLabelAdapter = {
  onOver(entityKey: string): boolean {
    const parsed = parseDimensionLabelKey(entityKey)
    if (!parsed) return false
    const cb = getDimCallbacks(parsed.cid)
    if (!cb) return false
    cb.onOver()
    return true
  },
  onOut(entityKey: string): boolean {
    const parsed = parseDimensionLabelKey(entityKey)
    if (!parsed) return false
    const cb = getDimCallbacks(parsed.cid)
    if (!cb) return false
    cb.onOut()
    return true
  },
  onClick(entityKey: string, clientX: number, clientY: number): boolean {
    const parsed = parseDimensionLabelKey(entityKey)
    if (!parsed) return false
    const cb = getDimCallbacks(parsed.cid)
    if (!cb) return false
    cb.onClick(clientX, clientY)
    return true
  },
  onDoubleClick(entityKey: string, clientX: number, clientY: number): boolean {
    const parsed = parseDimensionLabelKey(entityKey)
    if (!parsed) return false
    const cb = getDimCallbacks(parsed.cid)
    if (!cb) return false
    cb.onDoubleClick(clientX, clientY)
    return true
  },
  onPointerDown(entityKey: string, clientX: number, clientY: number): boolean {
    const parsed = parseDimensionLabelKey(entityKey)
    if (!parsed) return false
    const cb = getDimCallbacks(parsed.cid)
    if (!cb) return false
    cb.onPointerDown(clientX, clientY)
    return true
  },
}
