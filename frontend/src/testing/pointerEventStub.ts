/**
 * Give jsdom the PointerEvent constructor it does not implement.
 *
 * Without it, `fireEvent.pointer*` degrades to a plain Event that drops
 * `button`/`isPrimary`, so the Viewport's `isPrimary` and `pointerType` gates
 * never behave like the browser's. The Viewport test files used to copy this
 * stub one file at a time; it lives here now. The pointer-type default stays a
 * caller choice because the copies disagreed on purpose: `'mouse'` models a
 * real mouse pointer, `''` models an event that carries no pointer type, and
 * the Viewport branches on the two (`useRubberBandSelect` only sweeps on
 * `'mouse'`). The guard keeps a real implementation in place if a future
 * jsdom ships one.
 */
export function installPointerEventStub(pointerTypeDefault: 'mouse' | ''): void {
  if (typeof window.PointerEvent === 'function') return
  window.PointerEvent = class PointerEventStub extends MouseEvent {
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      // Defaults model the inert event: not the primary pointer (a test that
      // means a primary pointer passes isPrimary in its init), pointer id 0,
      // and the caller's pointer type. enumerable so React's reads see them.
      Object.defineProperty(this, 'isPrimary', { value: init.isPrimary ?? false, enumerable: true })
      Object.defineProperty(this, 'pointerId', { value: init.pointerId ?? 0, enumerable: true })
      Object.defineProperty(this, 'pointerType', { value: init.pointerType ?? pointerTypeDefault, enumerable: true })
    }
  } as unknown as typeof PointerEvent
}
