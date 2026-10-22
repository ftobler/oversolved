// The section arrow owns a viewer-state drag: past the click threshold it maps
// cursor travel along the plane normal onto `offset`. It must never produce a
// Mutation or a solve request, and it must release the camera orbit lock on
// release and unmount.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import { DEFAULT_PART_EDITOR_DATA, usePartEditorStore } from '@/stores/partEditorStore'
import { DEFAULT_SECTION_STATE, useSectionStore } from '@/stores/sectionStore'

const seams = vi.hoisted(() => ({
  callbacks: null as {
    onPointerDown: (x: number, y: number) => void
    onDoubleClick: (x: number, y: number) => void
  } | null,
  registration: null as Record<string, unknown> | null,
  closestParam: vi.fn(),
}))

vi.mock('@react-three/fiber', async () => {
  const three = await import('three')
  return {
    useFrame: () => {},
    useThree: () => ({
      camera: new three.OrthographicCamera(),
      gl: {
        domElement: {
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
        },
      },
    }),
  }
})

vi.mock('@/picking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/picking')>()),
  useFeatureHandleIdRegistration: (args: Record<string, unknown>) => { seams.registration = args },
}))

vi.mock('@/components/Viewport/idDispatch/featureHandleCallbacks', () => ({
  registerFeatureHandleCallbacks: (
    _key: string,
    cb: { onPointerDown: (x: number, y: number) => void; onDoubleClick: (x: number, y: number) => void },
  ) => {
    seams.callbacks = cb
    return () => { seams.callbacks = null }
  },
}))

vi.mock('@/utils/gizmoMath', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/gizmoMath')>()),
  closestParamOnAxis: (...a: unknown[]) => seams.closestParam(...a),
}))

import SectionPlaneHandle from '@/components/Viewport/SectionPlaneHandle'
import { SECTION_HANDLE_FEATURE_ID, SECTION_HANDLE_KEY } from '@/viewport/sectionHandle'

beforeEach(() => {
  seams.callbacks = null
  seams.registration = null
  seams.closestParam.mockReset()
  useSketchEditorStore.setState({ isPointerDown: false, hoveredSelectionId: null })
  usePartEditorStore.setState({ ...DEFAULT_PART_EDITOR_DATA })
  useSectionStore.setState({ ...DEFAULT_SECTION_STATE })
  setSketchCallback('onMutation', null)
})

afterEach(() => {
  cleanup()
  setSketchCallback('onMutation', null)
})

describe('SectionPlaneHandle', () => {
  it('registers the arrow on the feature-handle layer under its own key', () => {
    useSectionStore.setState({ enabled: true, offset: 2 })
    render(<SectionPlaneHandle />)

    expect(SECTION_HANDLE_KEY).toBe(`fhandle:${SECTION_HANDLE_FEATURE_ID}:offset`)
    expect(seams.registration).toMatchObject({
      featureId: SECTION_HANDLE_FEATURE_ID,
      field: 'offset',
      enabled: true,
    })
    // The grab segment starts on the plane (builtin front at z = offset).
    expect((seams.registration!.start as number[])[2]).toBeCloseTo(2, 9)
  })

  it('drags offset without a mutation or a solve request', () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    const before = usePartEditorStore.getState()
    useSectionStore.setState({ enabled: true, offset: 2 })
    render(<SectionPlaneHandle />)

    seams.closestParam.mockReturnValueOnce(5).mockReturnValueOnce(7)
    act(() => { seams.callbacks!.onPointerDown(100, 100) })
    expect(useSketchEditorStore.getState().isPointerDown).toBe(true)

    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 130, clientY: 100 })) })
    expect(useSectionStore.getState().offset).toBe(4)

    seams.closestParam.mockReturnValue(8)
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 140, clientY: 100 })) })
    expect(useSectionStore.getState().offset).toBe(5)

    act(() => { window.dispatchEvent(new MouseEvent('pointerup')) })
    expect(useSketchEditorStore.getState().isPointerDown).toBe(false)
    expect(onMutation).not.toHaveBeenCalled()
    // The document is untouched: a section drag is viewer state.
    expect(usePartEditorStore.getState().doc).toBe(before.doc)
    expect(usePartEditorStore.getState().solveResults).toBe(before.solveResults)
  })

  it('leaves offset alone until the drag passes the click threshold', () => {
    useSectionStore.setState({ enabled: true, offset: 2 })
    render(<SectionPlaneHandle />)

    act(() => { seams.callbacks!.onPointerDown(100, 100) })
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 102, clientY: 101 })) })
    expect(useSectionStore.getState().offset).toBe(2)
    act(() => { window.dispatchEvent(new MouseEvent('pointerup')) })
  })

  it('does not register the arrow while the section is off', () => {
    render(<SectionPlaneHandle />)
    expect(seams.registration).toMatchObject({ enabled: false })
    expect(seams.callbacks).toBeNull()
  })
})
