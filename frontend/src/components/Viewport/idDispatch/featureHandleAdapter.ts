import { getFeatureHandleCallbacks } from './featureHandleCallbacks'

/**
 * Route `featureHandle` ID-layer hits to the registered handle callbacks.
 * The entity key is `fhandle:<featureId>:<field>` and is used verbatim as
 * the registry key; no parsing is needed because a handle never carries
 * sub-keys. Hover is store-based (setSelectionIdOnHover) and not routed here.
 */
export const featureHandleAdapter = {
  onPointerDown(entityKey: string, clientX: number, clientY: number): boolean {
    const cb = getFeatureHandleCallbacks(entityKey)
    if (!cb) return false
    cb.onPointerDown(clientX, clientY)
    return true
  },
  onDoubleClick(entityKey: string, clientX: number, clientY: number): boolean {
    const cb = getFeatureHandleCallbacks(entityKey)
    if (!cb) return false
    cb.onDoubleClick(clientX, clientY)
    return true
  },
}
