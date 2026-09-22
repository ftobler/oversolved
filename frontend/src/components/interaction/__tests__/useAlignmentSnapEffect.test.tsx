import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import * as THREE from 'three'
import { useAlignmentSnapEffect } from '../useAlignmentSnapEffect'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

// The hook reads the camera from R3F to turn the screen-pixel tolerance into
// world units. The holder lets the mocked factory see a camera the test swaps
// per case, without re-importing the module.
const r3f = vi.hoisted(() => ({ camera: null as THREE.OrthographicCamera | null }))
vi.mock('@react-three/fiber', () => ({ useThree: () => ({ camera: r3f.camera }) }))

function orthoCamera(zoom: number): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-100, 100, 100, -100, -1000, 1000)
  cam.zoom = zoom
  cam.updateProjectionMatrix()
  return cam
}

describe('useAlignmentSnapEffect', () => {
  beforeEach(() => {
    r3f.camera = orthoCamera(1)
    useSketchEditorStore.setState({ alignmentSnapPoint: null, alignmentSnapKind: null })
  })

  it('records the segment start as the snap reference when the cursor is axis-aligned', () => {
    renderHook(() => useAlignmentSnapEffect([60, 20], [10, 20]))

    const s = useSketchEditorStore.getState()
    expect(s.alignmentSnapKind).toBe('kinda_horizontal')
    // The reference is the segment's own start, so the constraint names the line
    // being drawn, not a second point to merge with.
    expect(s.alignmentSnapPoint).toEqual([10, 20])
  })

  it('clears a prior snap when the cursor is not axis-aligned', () => {
    useSketchEditorStore.setState({ alignmentSnapPoint: [9, 9], alignmentSnapKind: 'kinda_vertical' })

    renderHook(() => useAlignmentSnapEffect([10, 10], [0, 0]))

    const s = useSketchEditorStore.getState()
    expect(s.alignmentSnapKind).toBeNull()
    expect(s.alignmentSnapPoint).toBeNull()
  })

  it('clears the snap when the current position or the last draw point is missing', () => {
    useSketchEditorStore.setState({ alignmentSnapPoint: [1, 1], alignmentSnapKind: 'kinda_horizontal' })

    const { rerender } = renderHook(
      ({ p, last }: { p: [number, number] | null; last: [number, number] | null }) =>
        useAlignmentSnapEffect(p, last),
      { initialProps: { p: null as [number, number] | null, last: [0, 0] as [number, number] | null } },
    )
    expect(useSketchEditorStore.getState().alignmentSnapKind).toBeNull()

    useSketchEditorStore.setState({ alignmentSnapPoint: [1, 1], alignmentSnapKind: 'kinda_horizontal' })
    rerender({ p: [5, 0], last: null })
    expect(useSketchEditorStore.getState().alignmentSnapKind).toBeNull()
  })

  // The tolerance is a SCREEN distance, so the hook has to convert it through
  // the camera's world-per-pixel. Without that, a zoomed-out view would snap at
  // a world distance that looks arbitrarily small on screen.
  it('derives the world tolerance from the camera zoom', () => {
    r3f.camera = orthoCamera(0.5)  // 1 world unit per 2 px: 20 px becomes 40 world
    renderHook(() => useAlignmentSnapEffect([1000, 30], [0, 0]))
    expect(useSketchEditorStore.getState().alignmentSnapKind).toBe('kinda_horizontal')

    useSketchEditorStore.setState({ alignmentSnapPoint: null, alignmentSnapKind: null })
    r3f.camera = orthoCamera(1)  // 20 world tolerance: the same 30 is now out of reach
    renderHook(() => useAlignmentSnapEffect([1000, 30], [0, 0]))
    expect(useSketchEditorStore.getState().alignmentSnapKind).toBeNull()
  })
})
