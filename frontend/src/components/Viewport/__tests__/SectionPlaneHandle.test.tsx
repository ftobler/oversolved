// The section gizmo owns viewer-state drags: past the click threshold the
// offset arrow maps cursor travel along the (tilted) normal onto `offset`, and
// the pitch/yaw rings turn the plane through the shared ring-drag law. Neither
// may produce a Mutation or a solve request, and both must release the camera
// orbit lock on release and unmount.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as THREE from 'three'
import { render, act, cleanup } from '@testing-library/react'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import { DEFAULT_PART_EDITOR_DATA, usePartEditorStore } from '@/stores/partEditorStore'
import { DEFAULT_SECTION_STATE, useSectionStore } from '@/stores/sectionStore'
import { TurntableControls } from '@/components/Viewport/turntable'
import { createPointerClaims } from '@/viewport/pointerClaim'
import { installPointerEventStub } from '@/testing/pointerEventStub'

interface HandleCallbacks {
  onPointerDown: (x: number, y: number) => void
  onDoubleClick: (x: number, y: number) => void
}

const seams = vi.hoisted(() => {
  const domElement = document.createElement('canvas')
  Object.defineProperty(domElement, 'clientWidth', { value: 800 })
  Object.defineProperty(domElement, 'clientHeight', { value: 600 })
  Object.defineProperty(domElement, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  })
  return {
    registrations: [] as Array<Record<string, unknown>>,
    callbacks: new Map<string, HandleCallbacks>(),
    // The dial and the ring line are drei renderers; their props are all this
    // test needs to see.
    dial: null as Record<string, unknown> | null,
    closestParam: vi.fn(),
    camera: null as unknown as THREE.OrthographicCamera,
    gl: { domElement },
  }
})

installPointerEventStub('touch')

vi.mock('@react-three/fiber', () => ({
  useFrame: () => {},
  useThree: () => ({
    camera: seams.camera,
    gl: seams.gl,
  }),
}))

vi.mock('@/picking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/picking')>()),
  useFeatureHandleIdRegistration: (args: Record<string, unknown>) => { seams.registrations.push(args) },
}))

vi.mock('@/components/Viewport/idDispatch/featureHandleCallbacks', () => ({
  registerFeatureHandleCallbacks: (key: string, cb: HandleCallbacks) => {
    seams.callbacks.set(key, cb)
    return () => { if (seams.callbacks.get(key) === cb) seams.callbacks.delete(key) }
  },
}))

vi.mock('@/components/Viewport/GizmoRing', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/AngleDial', () => ({
  default: (props: Record<string, unknown>) => { seams.dial = props; return null },
}))

vi.mock('@/utils/gizmoMath', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/gizmoMath')>()),
  closestParamOnAxis: (...a: unknown[]) => seams.closestParam(...a),
}))

import SectionPlaneHandle from '@/components/Viewport/SectionPlaneHandle'
import {
  SECTION_HANDLE_FEATURE_ID, SECTION_HANDLE_KEY, SECTION_PITCH_RING_KEY, SECTION_YAW_RING_KEY,
} from '@/viewport/sectionHandle'
import { GIZMO_PIXELS, RING_RADIUS } from '@/utils/gizmoPickGeometry'

const DEG = Math.PI / 180
const RING_WORLD_RADIUS = RING_RADIUS * GIZMO_PIXELS

/** The latest registration for a handle. The arrow carries no explicit key. */
function registration(key: string): Record<string, unknown> | undefined {
  return [...seams.registrations].reverse().find(r => (key === SECTION_HANDLE_KEY ? r.field === 'offset' : r.key === key))
}

function registeredKeys(): string[] {
  return seams.registrations
    .filter(r => r.enabled === true)
    .map(r => (r.key as string | undefined) ?? SECTION_HANDLE_KEY)
}

function pointerMove(clientX: number, clientY: number): void {
  act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY })) })
}

// A camera looking straight at the front plane's pitch ring (about +X), so the
// ring is face-on and screen pixels map one-to-one onto world units.
function aimAtPitchRing(): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-400, 400, 300, -300, -1000, 1000)
  camera.position.set(100, 0, 0)
  camera.up.set(0, 1, 0)
  camera.lookAt(0, 0, 0)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  seams.camera = camera
  return camera
}

// Screen position of a point on the y/z plane the camera faces: screen right
// is -Z, screen up is +Y.
function screenAt(y: number, z: number): [number, number] {
  return [400 - z, 300 - y]
}

beforeEach(() => {
  seams.registrations = []
  seams.callbacks = new Map()
  seams.dial = null
  seams.closestParam.mockReset()
  seams.camera = new THREE.OrthographicCamera(-400, 400, 300, -300, -1000, 1000)
  seams.camera.position.set(20, 20, 100)
  seams.camera.updateProjectionMatrix()
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
    expect(registration(SECTION_HANDLE_KEY)).toMatchObject({
      featureId: SECTION_HANDLE_FEATURE_ID,
      field: 'offset',
      enabled: true,
    })
    // The grab segment starts on the plane (builtin front at z = offset).
    expect((registration(SECTION_HANDLE_KEY)!.start as number[])[2]).toBeCloseTo(2, 9)
  })

  it('registers the two tilt rings as closed chains, and no roll ring', () => {
    useSectionStore.setState({ enabled: true })
    render(<SectionPlaneHandle />)

    expect(registeredKeys()).toEqual(
      expect.arrayContaining([SECTION_HANDLE_KEY, SECTION_PITCH_RING_KEY, SECTION_YAW_RING_KEY]),
    )
    expect(registeredKeys()).toHaveLength(3)
    expect(seams.registrations.some(r => String(r.key).includes('roll'))).toBe(false)
    for (const key of [SECTION_PITCH_RING_KEY, SECTION_YAW_RING_KEY]) {
      // A closed chain: RING_SEGMENTS + 1 points, the first repeated.
      expect((registration(key)!.points as unknown[]).length).toBe(65)
    }
    expect(seams.callbacks.has(SECTION_PITCH_RING_KEY)).toBe(true)
    expect(seams.callbacks.has(SECTION_YAW_RING_KEY)).toBe(true)
  })

  it('does not register the rings while the section is off or capturing', () => {
    render(<SectionPlaneHandle />)
    expect(registeredKeys()).toEqual([])

    cleanup()
    seams.registrations = []
    useSectionStore.setState({ enabled: true, capturing: true })
    render(<SectionPlaneHandle />)
    expect(registeredKeys()).toEqual([])
    expect(seams.callbacks.size).toBe(0)
  })

  it('drags offset without a mutation or a solve request', () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    const before = usePartEditorStore.getState()
    useSectionStore.setState({ enabled: true, offset: 2 })
    render(<SectionPlaneHandle />)

    seams.closestParam.mockReturnValueOnce(5).mockReturnValueOnce(7)
    act(() => { seams.callbacks.get(SECTION_HANDLE_KEY)!.onPointerDown(100, 100) })
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

  it('drags the arrow along the tilted normal, converting the offset back to the source normal', () => {
    // A 45 degree pitch: one world unit of travel along n' moves the cut by
    // one, which is 1/cos(45) along the source normal.
    useSectionStore.setState({ enabled: true, offset: 0, tilt: { pitch: 45 * DEG, yaw: 0 } })
    render(<SectionPlaneHandle />)

    seams.closestParam.mockReturnValueOnce(5).mockReturnValueOnce(5).mockReturnValueOnce(7)
    act(() => { seams.callbacks.get(SECTION_HANDLE_KEY)!.onPointerDown(100, 100) })
    pointerMove(130, 100)
    expect(useSectionStore.getState().offset).toBeCloseTo(0, 9)
    pointerMove(140, 100)
    expect(useSectionStore.getState().offset).toBeCloseTo(2 / Math.cos(45 * DEG), 9)
    expect(useSectionStore.getState().tilt).toEqual({ pitch: 45 * DEG, yaw: 0 })
    act(() => { window.dispatchEvent(new MouseEvent('pointerup')) })
  })

  it('turns the pitch ring a snapped quarter of its own swing, leaving offset and yaw alone', () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    const before = usePartEditorStore.getState()
    aimAtPitchRing()
    useSectionStore.setState({ enabled: true })
    render(<SectionPlaneHandle />)

    // Grab the pitch ring at +Y, drag 45 degrees toward +Z (well inside the
    // ring, so the 15 degree snap is armed).
    const [grabX, grabY] = screenAt(RING_WORLD_RADIUS, 0)
    const arm = 0.6 * RING_WORLD_RADIUS
    const [moveX, moveY] = screenAt(arm * Math.cos(45 * DEG), arm * Math.sin(45 * DEG))

    act(() => { seams.callbacks.get(SECTION_PITCH_RING_KEY)!.onPointerDown(grabX, grabY) })
    expect(useSketchEditorStore.getState().isPointerDown).toBe(true)
    pointerMove(moveX, moveY)

    const tilt = useSectionStore.getState().tilt
    expect(tilt.pitch).toBeCloseTo(45 * DEG, 9)
    expect(tilt.yaw).toBe(0)
    expect(useSectionStore.getState().offset).toBe(0)

    act(() => { window.dispatchEvent(new MouseEvent('pointerup')) })
    expect(useSketchEditorStore.getState().isPointerDown).toBe(false)
    expect(onMutation).not.toHaveBeenCalled()
    expect(usePartEditorStore.getState().doc).toBe(before.doc)
  })

  it('Escape mid-drag puts the ring back where the press found it', () => {
    aimAtPitchRing()
    useSectionStore.setState({ enabled: true, tilt: { pitch: 10 * DEG, yaw: 0 } })
    render(<SectionPlaneHandle />)

    const [grabX, grabY] = screenAt(RING_WORLD_RADIUS, 0)
    const arm = 0.6 * RING_WORLD_RADIUS
    const [moveX, moveY] = screenAt(arm * Math.cos(45 * DEG), arm * Math.sin(45 * DEG))

    act(() => { seams.callbacks.get(SECTION_PITCH_RING_KEY)!.onPointerDown(grabX, grabY) })
    pointerMove(moveX, moveY)
    expect(useSectionStore.getState().tilt.pitch).toBeCloseTo(10 * DEG + 45 * DEG, 9)

    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(useSectionStore.getState().tilt).toEqual({ pitch: 10 * DEG, yaw: 0 })
    expect(useSketchEditorStore.getState().isPointerDown).toBe(false)
    act(() => { window.dispatchEvent(new MouseEvent('pointerup')) })
  })

  it('a touch drag moves the offset and leaves the camera where it was', () => {
    // The reported bug: the arrow's drag never closed the orbit gate, and the
    // claim is what closes it at the press. The moves land before React commits
    // the arrow's local dragging state, so only the claim can protect them.
    useSectionStore.setState({ enabled: true, offset: 2 })
    const camera = seams.camera
    const controls = new TurntableControls(camera, seams.gl.domElement)
    controls.azimuth = 0.4
    controls.elevation = 0.3
    controls.update()
    const claims = createPointerClaims()
    controls.pointerClaimed = id => claims.isClaimed(id)
    const before = { position: camera.position.toArray(), quaternion: camera.quaternion.toArray() }

    render(<SectionPlaneHandle />)
    seams.closestParam.mockReturnValueOnce(5).mockReturnValueOnce(7)

    act(() => {
      // The controller saw the press first, as the canvas listener order does.
      seams.gl.domElement.dispatchEvent(new PointerEvent('pointerdown', {
        pointerType: 'touch', pointerId: 33, isPrimary: true, button: 0,
        clientX: 100, clientY: 100, bubbles: true, cancelable: true,
      }))
      // The dispatcher routes the same press to the arrow and claims the pointer.
      seams.callbacks.get(SECTION_HANDLE_KEY)!.onPointerDown(100, 100)
      claims.claim(33)
      document.dispatchEvent(new PointerEvent('pointermove', {
        pointerType: 'touch', pointerId: 33, clientX: 130, clientY: 100, bubbles: true,
      }))
    })

    expect(useSectionStore.getState().offset).toBe(4)
    expect({ position: camera.position.toArray(), quaternion: camera.quaternion.toArray() }).toEqual(before)

    act(() => {
      document.dispatchEvent(new PointerEvent('pointerup', {
        pointerType: 'touch', pointerId: 33, clientX: 130, clientY: 100, bubbles: true,
      }))
    })
    controls.dispose()
  })

  it('leaves offset alone until the drag passes the click threshold', () => {
    useSectionStore.setState({ enabled: true, offset: 2 })
    render(<SectionPlaneHandle />)

    act(() => { seams.callbacks.get(SECTION_HANDLE_KEY)!.onPointerDown(100, 100) })
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 102, clientY: 101 })) })
    expect(useSectionStore.getState().offset).toBe(2)
    act(() => { window.dispatchEvent(new MouseEvent('pointerup')) })
  })

  it('does not register the arrow while the section is off', () => {
    render(<SectionPlaneHandle />)
    expect(registration(SECTION_HANDLE_KEY)).toMatchObject({ enabled: false })
    expect(seams.callbacks.size).toBe(0)
  })

  it('hides the arrow and its grab segment while a thumbnail capture runs', () => {
    useSectionStore.setState({ enabled: true, capturing: true })
    render(<SectionPlaneHandle />)
    expect(registration(SECTION_HANDLE_KEY)).toMatchObject({ enabled: false })
    expect(seams.callbacks.size).toBe(0)
  })
})
