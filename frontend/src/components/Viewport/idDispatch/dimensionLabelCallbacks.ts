/**
 * Module-level registry mapping a dimension constraint id to the
 * `useDimInteraction` callbacks currently owned by the visible
 * Linear / Radial / Angle component.
 *
 * The id-buffer pointer dispatcher consults this registry to invoke
 * onOver / onOut / onClick for a hit on the `dimensionLabel` ID layer,
 * without taking a direct React reference to the dimension components.
 */

export interface DimCallbacks {
  onOver: () => void
  onOut: () => void
  onClick: (clientX: number, clientY: number) => void
}

const callbacks = new Map<string, DimCallbacks>()

export function registerDimCallbacks(cid: string, cb: DimCallbacks): () => void {
  callbacks.set(cid, cb)
  return () => {
    if (callbacks.get(cid) === cb) callbacks.delete(cid)
  }
}

export function getDimCallbacks(cid: string): DimCallbacks | undefined {
  return callbacks.get(cid)
}

/** Test helper. */
export function resetDimCallbacksForTest(): void {
  callbacks.clear()
}
