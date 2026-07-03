/**
 * Module-level registry mapping a feature editing handle (featureId + field,
 * keyed as `fhandle:<featureId>:<field>`) to the callbacks currently owned
 * by the visible FeatureHandles arrow.
 *
 * The id-buffer pointer dispatcher consults this registry to invoke
 * onPointerDown / onDoubleClick for a hit on the `featureHandle` ID layer,
 * without taking a direct React reference to the handle component. Hover is
 * NOT routed here: it rides hoveredSelectionId like the B-rep layers, so the
 * rubber-band guard and clearAllHover teardown cover handles for free.
 * Mirrors dimensionLabelCallbacks.
 */

export interface FeatureHandleCallbacks {
  onPointerDown: (clientX: number, clientY: number) => void
  onDoubleClick: (clientX: number, clientY: number) => void
}

const callbacks = new Map<string, FeatureHandleCallbacks>()

export function registerFeatureHandleCallbacks(key: string, cb: FeatureHandleCallbacks): () => void {
  callbacks.set(key, cb)
  return () => {
    if (callbacks.get(key) === cb) callbacks.delete(key)
  }
}

export function getFeatureHandleCallbacks(key: string): FeatureHandleCallbacks | undefined {
  return callbacks.get(key)
}

/** Test helper. */
export function resetFeatureHandleCallbacksForTest(): void {
  callbacks.clear()
}
