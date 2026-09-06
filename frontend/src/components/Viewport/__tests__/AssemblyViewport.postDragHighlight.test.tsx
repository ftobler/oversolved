// M3: the selection highlight reads `pickGeometry`, baked in pre-drag world
// coordinates until the post-commit re-solve lands, and it sits OUTSIDE the
// drawn part groups. The viewport used to gate it on the live `manipulating`
// flag, which flips false the instant the pointer lifts -- a solve round trip
// before `pickGeometry` is re-baked. It is now gated on `pickGeometryStale`,
// which spans exactly that window.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEffect } from 'react'
import { render, act } from '@testing-library/react'

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
vi.mock('@/components/Viewport/assembly/AssemblyPickLayers', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/AssemblySelectionHighlight', () => ({
  default: () => <div data-testid="assembly-selection-highlight" />,
}))
vi.mock('@/components/Viewport/assembly/GizmoPickLayer', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/RollGuideGizmo', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/TriadGizmo', () => ({ default: () => null }))

import AssemblyViewport from '../AssemblyViewport'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'

beforeEach(() => {
  useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
  useAssemblyStore.setState({ pickGeometryStale: false, selection: new Set() } as never)
})

describe('AssemblyViewport post-drag selection highlight gate', () => {
  it('mounts the selection highlight in the plain settled state', () => {
    const { queryByTestId } = render(<AssemblyViewport />)
    expect(queryByTestId('assembly-selection-highlight')).not.toBeNull()
  })

  it('hides the selection highlight while a committed drag is settling, even after manipulating flips false', () => {
    // The state right after handlePointerUp: no live manipulation session, but
    // pickGeometry still baked at the pre-drag pose.
    useAssemblyStore.setState({ manipulation: null, pickGeometryStale: true } as never)
    const { queryByTestId } = render(<AssemblyViewport />)
    expect(queryByTestId('assembly-selection-highlight')).toBeNull()
  })

  it('shows the selection highlight again once the settling solve lands', () => {
    useAssemblyStore.setState({ pickGeometryStale: true } as never)
    const { queryByTestId, rerender } = render(<AssemblyViewport />)
    expect(queryByTestId('assembly-selection-highlight')).toBeNull()

    act(() => {
      useAssemblyStore.getState().setSolveResult({
        transforms: {}, bodies: {}, edgeCurves: {}, entityMateRefs: {},
        anchors: {}, pickGeometry: [], mateResults: {},
      })
    })
    rerender(<AssemblyViewport />)
    expect(queryByTestId('assembly-selection-highlight')).not.toBeNull()
  })
})
