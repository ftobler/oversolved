// Regression: orbiting the camera in the assembly editor wiped the selection.
//
// The camera runs on the RIGHT button (SceneController maps LEFT to no camera
// action), and Chrome on Linux fires `contextmenu` on the pointer-DOWN that
// opens the orbit. R3F counts `contextmenu` as a click event, so with nothing
// under the cursor it reaches the Canvas `onPointerMissed` -- at zero travel,
// which is why R3F's own `delta <= 2` guard lets it through. The old assembly
// handler cleared unconditionally and lost the selection on the first pixel of
// every rotation. The part editor already gated its clear on the gesture; both
// now share utils/clickGesture.
//
// Driven viewport-free: the same tracker + predicate the viewport calls, against
// the real assemblyStore, so a pass means the real gesture keeps the real state.

import { describe, it, expect, beforeEach } from 'vitest'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'
import { missClearsSelection } from '@/utils/assemblyPointer'
import { createClickGestureTracker, type ClickGestureTracker } from '@/utils/clickGesture'
import { CLICK_THRESHOLD_PX } from '@/components/Geometry3D/constants'

const FACE = 'face:part-a:3'
const OTHER_FACE = 'face:part-b:1'

/** The viewport's onPointerMissed body, minus the viewport. */
function pointerMissed(gesture: ClickGestureTracker, adapterActive = false): void {
  if (!missClearsSelection(gesture.state, adapterActive)) return
  const store = useAssemblyStore.getState()
  store.setSelectedPartHandle(null)
  store.setSelectedMateId(null)
  if (store.activeMateField === null) store.clearSelection()
}

/** The viewport's pointer-up selection branch, minus the viewport. */
function pointerUpSelect(gesture: ClickGestureTracker, button: number, hitKey: string | null): void {
  const store = useAssemblyStore.getState()
  if (store.activeMateField !== null || button !== 0) return
  if (gesture.state.button !== 0 || gesture.state.wasDrag) return
  if (hitKey) store.toggleSelection(hitKey)
}

describe('assembly: camera manipulation never disturbs the selection', () => {
  let gesture: ClickGestureTracker

  beforeEach(() => {
    useAssemblyStore.setState({
      ...DEFAULT_ASSEMBLY_EDITOR_DATA,
      selection: new Set([FACE]),
      selectedPartHandle: 'part-a',
    })
    gesture = createClickGestureTracker()
  })

  it('keeps the selection through a right-button orbit that misses on pointer-down', () => {
    gesture.down(2, 400, 300)
    // Chrome/Linux: contextmenu (an R3F click event) lands here, before any move.
    pointerMissed(gesture)
    expect(useAssemblyStore.getState().selection.has(FACE)).toBe(true)
    expect(useAssemblyStore.getState().selectedPartHandle).toBe('part-a')

    gesture.move(600, 380)
    gesture.up(600, 380)
    pointerMissed(gesture)
    expect(useAssemblyStore.getState().selection.has(FACE)).toBe(true)
    expect(useAssemblyStore.getState().selectedPartHandle).toBe('part-a')
  })

  it('keeps the selection through a middle-button pan', () => {
    gesture.down(1, 400, 300)
    gesture.move(500, 300)
    gesture.up(500, 300)
    pointerMissed(gesture)
    expect(useAssemblyStore.getState().selection.has(FACE)).toBe(true)
  })

  it('keeps the selection when a left drag exceeds the click threshold', () => {
    gesture.down(0, 400, 300)
    gesture.move(400 + CLICK_THRESHOLD_PX + 1, 300)
    gesture.up(400 + CLICK_THRESHOLD_PX + 1, 300)
    pointerMissed(gesture)
    expect(useAssemblyStore.getState().selection.has(FACE)).toBe(true)
  })

  it('keeps the selection when an orbit returns to where it started', () => {
    gesture.down(2, 400, 300)
    gesture.move(700, 500)
    gesture.up(400, 300)  // back on the origin pixel: end points alone would say "click"
    pointerMissed(gesture)
    expect(useAssemblyStore.getState().selection.has(FACE)).toBe(true)
  })

  it('still clears on a stationary left click in empty space', () => {
    gesture.down(0, 400, 300)
    gesture.up(400, 300)
    pointerMissed(gesture)
    expect(useAssemblyStore.getState().selection.size).toBe(0)
    expect(useAssemblyStore.getState().selectedPartHandle).toBeNull()
  })

  it('still selects on a stationary left click that hits an entity', () => {
    gesture.down(0, 400, 300)
    gesture.up(400, 300)
    pointerUpSelect(gesture, 0, OTHER_FACE)
    expect(useAssemblyStore.getState().selection.has(OTHER_FACE)).toBe(true)
  })

  it('does not select when the left gesture became a drag', () => {
    gesture.down(0, 400, 300)
    gesture.move(400 + CLICK_THRESHOLD_PX + 1, 300)
    gesture.up(400 + CLICK_THRESHOLD_PX + 1, 300)
    pointerUpSelect(gesture, 0, OTHER_FACE)
    expect(useAssemblyStore.getState().selection.has(OTHER_FACE)).toBe(false)
  })

  it('does not clear while a part-manipulation session owns the pointer', () => {
    gesture.down(0, 400, 300)
    gesture.up(400, 300)
    pointerMissed(gesture, true)
    expect(useAssemblyStore.getState().selection.has(FACE)).toBe(true)
  })
})
