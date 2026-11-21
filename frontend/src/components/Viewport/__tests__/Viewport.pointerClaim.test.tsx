// @vitest-environment jsdom
// The part viewport's claim wiring, end to end: the dispatcher resolves a
// handle press and claims the pointer, and the very controller that viewport
// built reads that claim. Splitting the registry (the dispatcher writing one
// instance and SceneController reading another) would rotate the camera here,
// because nothing else closes the orbit gate for a section arrow or a handle
// that refuses its drag.
import React, { useEffect } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import * as THREE from 'three'
import { FEATURE_HANDLE_LAYER_NAME, IdPipeline, type ResolvedHit } from '@/picking'
import { setLivePipeline } from '@/picking/IdPipelineContext'
import { usePartEditorStore, DEFAULT_PART_EDITOR_DATA } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import { DEFAULT_SECTION_STATE, useSectionStore } from '@/stores/sectionStore'
import { installPointerEventStub } from '@/testing/pointerEventStub'
import Viewport from '@/components/Viewport'

const h = vi.hoisted(() => {
  const domElement = document.createElement('canvas')
  domElement.width = 800
  domElement.height = 600
  Object.defineProperty(domElement, 'clientWidth', { value: 800 })
  Object.defineProperty(domElement, 'clientHeight', { value: 600 })
  Object.defineProperty(domElement, 'getBoundingClientRect', {
    value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() { return {} } }),
  })
  return {
    camera: null as unknown as THREE.OrthographicCamera,
    gl: { domElement, localClippingEnabled: false, toneMappingExposure: 1 },
    // No frame is ever drawn here: the camera and the pick resolver are the
    // only scene state the claim path reads.
    scene: {} as unknown as THREE.Scene,
    invalidate: vi.fn(),
  }
})

installPointerEventStub('touch')

vi.mock('@react-three/fiber', () => {
  const state = () => ({
    camera: h.camera,
    gl: h.gl,
    scene: h.scene,
    invalidate: h.invalidate,
    size: { width: 800, height: 600 },
  })
  return {
    Canvas: ({ children, onCreated }: { children: React.ReactNode; onCreated?: (s: unknown) => void }) => {
      useEffect(() => { onCreated?.({ gl: h.gl, scene: h.scene }) }, [onCreated])
      return <div>{children}</div>
    },
    useFrame: () => {},
    useThree: (selector?: (s: Record<string, unknown>) => unknown) => {
      const current = state()
      return selector ? selector(current) : current
    },
  }
})

vi.mock('@react-three/drei', () => ({
  Environment: () => null,
  Html: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Line: () => null,
  Text: () => null,
  OrthographicCamera: () => null,
}))
vi.mock('@/picking/IdPickingDriver', () => ({ default: () => null }))
vi.mock('@/components/Viewport/FeatureHandles', () => ({ default: () => null }))
vi.mock('@/components/Viewport/SectionPlaneHandle', () => ({ default: () => null }))
vi.mock('@/components/Viewport/SceneProbeDriver', () => ({ default: () => null }))
vi.mock('@/components/Viewport/IdDebugOverlay', () => ({ default: () => null }))
vi.mock('@/components/Viewport/EnvLight', () => ({ default: () => null, ENV_INTENSITY: 1, __esModule: true }))
vi.mock('@/components/Viewport/OriginMarker', () => ({ default: () => null }))
vi.mock('@/components/Viewport/ReferencePlane', () => ({ default: () => null }))
vi.mock('@/components/Viewport/UserDefinedPlane', () => ({ default: () => null }))
vi.mock('@/components/Viewport/PlaneVisual', () => ({ PlaneSurface: () => null, PlaneLabel: () => null }))
vi.mock('@/components/Viewport/HelixCurve', () => ({ default: () => null }))
vi.mock('@/components/Geometry3D', () => ({ default: () => null, __esModule: true }))
vi.mock('@/components/Geometry3D/Part3D', () => ({ default: () => null, __esModule: true }))
vi.mock('@/components/Geometry3D/PreviewEdgeOverlay', () => ({ default: () => null, __esModule: true }))
vi.mock('@/components/misc/CubeGizmo', () => ({ CubeGizmoCanvas: () => null }))
vi.mock('@/components/dialogs/ContextMenuDialog', () => ({ default: () => null, __esModule: true }))

const HANDLE_KEY = 'fhandle:extrude1:distance'
const handleHit: ResolvedHit = { id: 1, layer: FEATURE_HANDLE_LAYER_NAME, entityKey: HANDLE_KEY, distancePx: 0 }

describe('Viewport pointer claim wiring', () => {
  let pipeline: IdPipeline

  beforeEach(() => {
    h.camera = new THREE.OrthographicCamera(-400, 400, 300, -300, -1000, 1000)
    h.camera.position.set(20, 20, 100)
    h.camera.updateProjectionMatrix()
    h.invalidate.mockClear()
    pipeline = new IdPipeline({ width: 800, height: 600 })
    pipeline.target.markClean()
    setLivePipeline(pipeline)
    usePartEditorStore.setState({ ...DEFAULT_PART_EDITOR_DATA })
    useSketchEditorStore.setState({
      activeTool: null,
      drag: null,
      dragPending: null,
      isPointerDown: false,
      hoveredSelectionId: null,
    })
    useEditorState.setState({ activeSketchFeatureId: null, editingFeatureId: null })
    useSectionStore.setState({ ...DEFAULT_SECTION_STATE })
  })

  afterEach(() => {
    setLivePipeline(null)
    pipeline.dispose()
  })

  it('a dispatcher-claimed handle press keeps this viewport\'s camera still', () => {
    pipeline.resolveSync = vi.fn().mockReturnValue(handleHit)
    render(<Viewport />)

    const before = {
      position: h.camera.position.toArray(),
      quaternion: h.camera.quaternion.toArray(),
    }

    act(() => {
      // A touch press is both the handle press and a camera gesture. The
      // controller's layout-effect listener attached first, then the dispatcher
      // resolves the arrow and claims the same pointer.
      h.gl.domElement.dispatchEvent(new PointerEvent('pointerdown', {
        pointerType: 'touch', pointerId: 77, isPrimary: true, button: 0,
        clientX: 100, clientY: 100, bubbles: true, cancelable: true,
      }))
      expect(pipeline.resolveSync).toHaveBeenCalled()
      document.dispatchEvent(new PointerEvent('pointermove', {
        pointerType: 'touch', pointerId: 77, clientX: 200, clientY: 140, bubbles: true,
      }))
    })

    expect({
      position: h.camera.position.toArray(),
      quaternion: h.camera.quaternion.toArray(),
    }).toEqual(before)
  })
})
