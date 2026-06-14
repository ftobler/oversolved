// Orbit (camera pan/rotate) is disabled only while actively dragging a sketch
// element, which is inherently a pointer-down gesture: drag/dragPending are only
// meaningfully set between a sketch-element pointerdown and its release. Sketch
// dragging is the prime (and only) consumer of this camera-drag block.
//
// If the pointer is up, any lingering drag/dragPending is stuck state (e.g. a
// load race that remounts the DragPlane mid-gesture and loses the handler that
// would clear it), and the camera must stay free. isPointerDown is cleared on
// every pointerup by the Viewport-level runPointerUpCleanup, which survives
// DragPlane remounts -- so gating on it guarantees the camera can never freeze
// once the pointer is up.
export function deriveOrbitEnabled(
  isPointerDown: boolean,
  drag: unknown,
  dragPending: unknown,
): boolean {
  return !isPointerDown || (!drag && !dragPending)
}
