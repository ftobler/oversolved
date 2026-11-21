// T6: the assembly keeps its section builtin, offset and flip. The tilt is a
// part-viewport ring gesture, so entering the assembly drops a tilt left in the
// shared store and no section ring is ever registered here.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEffect } from 'react'
import { render, act } from '@testing-library/react'
import * as THREE from 'three'
import { DEFAULT_SECTION_STATE, useSectionStore } from '@/stores/sectionStore'
import { DEFAULT_ASSEMBLY_EDITOR_DATA, useAssemblyStore } from '@/stores/assemblyStore'
import { useViewOptionsStore } from '@/stores/viewOptionsStore'

const h = vi.hoisted(() => {
  const domElement = document.createElement('canvas')
  Object.defineProperty(domElement, 'clientWidth', { value: 800 })
  Object.defineProperty(domElement, 'clientHeight', { value: 600 })
  Object.defineProperty(domElement, 'getBoundingClientRect', {
    value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() { return {} } }),
  })
  return {
    camera: null as THREE.OrthographicCamera | null,
    gl: { domElement },
    scene: null as THREE.Scene | null,
    registrations: [] as Array<Record<string, unknown>>,
    pipeline: { resolveAllSync: vi.fn(() => [] as unknown[]), markDirty: vi.fn() },
  }
})

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children, onCreated }: { children: unknown; onCreated?: (s: unknown) => void }) => {
    useEffect(() => {
      onCreated?.({ gl: h.gl, scene: h.scene, camera: h.camera })
    }, [onCreated])
    return children as React.ReactNode
  },
  useThree: () => ({
    camera: h.camera,
    gl: h.gl,
    scene: h.scene,
    invalidate: vi.fn(),
    size: { width: 800, height: 600 },
  }),
  useFrame: () => {},
}))

vi.mock('@react-three/drei', () => ({ Environment: () => null }))
vi.mock('@/picking/IdPickingDriver', () => ({
  default: function IdPickingDriverStub({ onReady }: { onReady?: (p: unknown) => void }) {
    useEffect(() => { onReady?.(h.pipeline) }, [onReady])
    return null
  },
}))
vi.mock('@/components/Viewport/EnvLight', () => ({ default: () => null, ENV_INTENSITY: 1 }))
vi.mock('@/components/Viewport/IdDebugOverlay', () => ({ default: () => null }))
vi.mock('@/components/misc/CubeGizmo', () => ({ CubeGizmoCanvas: () => null }))
vi.mock('@/components/Viewport/assembly/AnchorGizmos', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/AssemblyPartMesh', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/AssemblyBuiltin', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/AssemblyPickLayers', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/AssemblySelectionHighlight', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/GizmoPickLayer', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/RollGuideGizmo', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/TriadGizmo', () => ({ default: () => null }))

vi.mock('@/picking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/picking')>()),
  useFeatureHandleIdRegistration: (args: Record<string, unknown>) => { h.registrations.push(args) },
}))

import AssemblyViewport from '@/components/Viewport/AssemblyViewport'

beforeEach(() => {
  h.camera = new THREE.OrthographicCamera(-400, 400, 300, -300, -1000, 1000)
  h.camera.position.set(20, 20, 100)
  h.camera.updateProjectionMatrix()
  h.scene = new THREE.Scene()
  h.registrations = []
  h.pipeline.resolveAllSync.mockReset()
  h.pipeline.resolveAllSync.mockImplementation(() => [])
  useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
  useAssemblyStore.setState({ pickGeometryPose: {}, entitySelection: new Set(), bodies: {} } as never)
  useViewOptionsStore.setState({})
  useSectionStore.setState({ ...DEFAULT_SECTION_STATE, enabled: true, tilt: { pitch: 0.5, yaw: 0.2 } })
})

describe('the assembly section ignores the part tilt', () => {
  it('resets a tilt left in the store on mount and never registers a ring', () => {
    act(() => { render(<AssemblyViewport />) })
    expect(useSectionStore.getState().tilt).toEqual({ pitch: 0, yaw: 0 })
    expect(useSectionStore.getState().enabled).toBe(true)
    expect(h.registrations.filter(r => String(r.key ?? '').startsWith('section:ring'))).toHaveLength(0)
  })
})
