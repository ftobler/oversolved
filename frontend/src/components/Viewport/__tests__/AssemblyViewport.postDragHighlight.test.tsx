// The ID pick buffer must describe the drawn pose, not the pose the last solve
// baked, or a click in the settle window lands on the wrong entity. The viewport
// wires the offset helper to both the ID layers and the selection highlight, so
// this pins that wiring with the R3F mocks the other viewport tests use.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEffect } from 'react'
import { render } from '@testing-library/react'

const captured = vi.hoisted(() => ({
  pickBodies: undefined as unknown,
  highlightBodies: undefined as unknown,
}))

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children, onCreated }: { children: unknown; onCreated?: (s: unknown) => void }) => {
    useEffect(() => { onCreated?.({ gl: { domElement: document.createElement('canvas') }, scene: {} }) }, [onCreated])
    return children as React.ReactNode
  },
}))
vi.mock('@react-three/drei', () => ({ Environment: () => null }))
vi.mock('@/picking/IdPickingDriver', () => ({ default: () => null }))
vi.mock('@/components/Viewport/SceneController', () => ({ default: () => null }))
vi.mock('@/components/Viewport/EnvLight', () => ({ default: () => null, ENV_INTENSITY: 1 }))
vi.mock('@/components/Viewport/IdDebugOverlay', () => ({ default: () => null }))
vi.mock('@/components/misc/CubeGizmo', () => ({ CubeGizmoCanvas: () => null }))
vi.mock('@/components/Viewport/assembly/AnchorGizmos', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/AssemblyBody', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/AssemblyBuiltin', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/AssemblyPickLayers', () => ({
  default: ({ bodies }: { bodies: unknown }) => { captured.pickBodies = bodies; return null },
}))
vi.mock('@/components/Viewport/assembly/AssemblySelectionHighlight', () => ({
  default: ({ pickBodies }: { pickBodies: unknown }) => {
    captured.highlightBodies = pickBodies
    return <div data-testid="assembly-selection-highlight" />
  },
}))
vi.mock('@/components/Viewport/assembly/GizmoPickLayer', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/RollGuideGizmo', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/TriadGizmo', () => ({ default: () => null }))

import AssemblyViewport from '../AssemblyViewport'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'
import type { AssemblyPickBody } from '@/utils/assemblyPick'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'

function pickBody(): AssemblyPickBody {
  return {
    handle: 'p1',
    bodyKey: 'p1:body_0',
    faces: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      triangleToFace: new Uint32Array([0]),
      faceQueries: ['f0'],
    },
    edges: null,
    vertices: null,
    faceBoundaries: null,
  }
}

beforeEach(() => {
  captured.pickBodies = undefined
  captured.highlightBodies = undefined
  useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
  useAssemblyStore.setState({
    pickGeometry: [], pickGeometryPose: {}, transforms: {}, settlingOffsets: {},
    entitySelection: new Set(),
  } as never)
})

describe('AssemblyViewport drawn pick geometry', () => {
  it('offsets the pick layers and the highlight onto the settling pose', () => {
    const body = pickBody()
    useAssemblyStore.setState({
      pickGeometry: [body],
      pickGeometryPose: { p1: IDENTITY_TRANSFORM },
      transforms: { p1: IDENTITY_TRANSFORM },
      settlingOffsets: { p1: { ...IDENTITY_TRANSFORM, tx: 3 } },
    } as never)

    render(<AssemblyViewport />)

    const bodies = captured.pickBodies as AssemblyPickBody[]
    expect(bodies).toHaveLength(1)
    expect(bodies[0].faces!.positions[0]).toBeCloseTo(3, 9)
    expect(captured.highlightBodies).toBe(bodies)
  })

  it('hands the baked body straight through at rest (identity offset, no churn)', () => {
    const body = pickBody()
    useAssemblyStore.setState({
      pickGeometry: [body],
      pickGeometryPose: { p1: IDENTITY_TRANSFORM },
      transforms: { p1: IDENTITY_TRANSFORM },
    } as never)

    render(<AssemblyViewport />)

    const bodies = captured.pickBodies as AssemblyPickBody[]
    expect(bodies[0]).toBe(body)
    expect(captured.highlightBodies).toBe(bodies)
  })

  it('mounts the selection highlight in the plain settled state', () => {
    const { queryByTestId } = render(<AssemblyViewport />)
    expect(queryByTestId('assembly-selection-highlight')).not.toBeNull()
  })
})
