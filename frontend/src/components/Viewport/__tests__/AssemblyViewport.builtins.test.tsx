// A fresh assembly has no feature flagged visible, yet its origin dot is on
// screen. The test mounts the real built-in component inside the viewport shell
// (the scene furniture is stubbed) and inspects the marker it draws.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'

const MockDot = vi.fn((_props: Record<string, unknown>) => null)
const MockPlaneSurface = vi.fn((_props: Record<string, unknown>) => null)

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children: unknown }) => children as React.ReactNode,
}))
vi.mock('@react-three/drei', () => ({ Environment: () => null }))
vi.mock('@/picking/IdPickingDriver', () => ({ default: () => null }))
vi.mock('@/components/Viewport/SceneController', () => ({ default: () => null }))
vi.mock('@/components/Viewport/EnvLight', () => ({ default: () => null, ENV_INTENSITY: 1 }))
vi.mock('@/components/Viewport/IdDebugOverlay', () => ({ default: () => null }))
vi.mock('@/components/misc/CubeGizmo', () => ({ CubeGizmoCanvas: () => null }))
vi.mock('@/components/Viewport/assembly/AnchorGizmos', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/AssemblyPartMesh', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/AssemblyPickLayers', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/AssemblySelectionHighlight', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/GizmoPickLayer', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/RollGuideGizmo', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/TriadGizmo', () => ({ default: () => null }))
vi.mock('@/components/Geometry3D/VertexDots', () => ({
  Dot: (props: Record<string, unknown>) => { MockDot(props); return null },
  VertexHighlight: () => null,
}))
vi.mock('@/components/Viewport/PlaneVisual', () => ({
  PlaneSurface: (props: Record<string, unknown>) => { MockPlaneSurface(props); return null },
  PlaneLabel: () => null,
}))

import AssemblyViewport from '../AssemblyViewport'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'
import { ASSEMBLY_BUILTIN_DEFAULTS } from '@/utils/assemblyBuiltins'
import { COLOR_INACTIVE } from '@/components/Geometry3D/constants'

beforeEach(() => {
  MockDot.mockClear()
  MockPlaneSurface.mockClear()
  const store = useAssemblyStore.getState()
  store.setSnapshot({
    ...DEFAULT_ASSEMBLY_EDITOR_DATA,
    doc: { kind: 'assembly', features: ASSEMBLY_BUILTIN_DEFAULTS.map(f => ({ ...f })) },
  })
})

describe('AssemblyViewport built-ins on a fresh document', () => {
  it('mounts the origin marker even though no feature carries visible:true', () => {
    render(<AssemblyViewport />)
    // StrictMode replays the scene render, so assert the marker is drawn rather
    // than counting how many times React committed it.
    expect(MockDot).toHaveBeenCalledWith(expect.objectContaining({
      color: COLOR_INACTIVE, px: 4, depthTest: false,
    }))
    expect(MockPlaneSurface).not.toHaveBeenCalled()
  })
})
