// DOM handle registry for the scene probe. One attribute scan, no effects and
// nothing to keep in sync: a toolbar button or tree row opts itself in by
// carrying the attribute, and `getSceneHandles` finds it when asked.

export const DOM_HANDLE_ATTRIBUTE = 'data-oversolved-handle'

/**
 * JSX spread helper so the attribute literal lives only in this module; an
 * absent handle contributes no attribute at all.
 */
export function domHandleProps(handle: string | undefined): { 'data-oversolved-handle'?: string } {
  return handle ? { [DOM_HANDLE_ATTRIBUTE]: handle } : {}
}

export interface DomHandleInfo {
  handle: string
  // Client-rect [x, y, width, height] in CSS pixels.
  rect: [number, number, number, number]
}

/** Everything under `root` carrying the attribute, in document order. */
export function scanDomHandles(root: ParentNode): DomHandleInfo[] {
  const found: DomHandleInfo[] = []
  for (const el of root.querySelectorAll(`[${DOM_HANDLE_ATTRIBUTE}]`)) {
    const handle = el.getAttribute(DOM_HANDLE_ATTRIBUTE)
    if (!handle) continue
    const r = el.getBoundingClientRect()
    found.push({ handle, rect: [r.left, r.top, r.width, r.height] })
  }
  return found
}
