// While a mate chip is armed the viewport aims references, but that must not
// turn off the B-rep hover highlight: the face/edge under the cursor is still
// the thing the anchor orbs belong to. Both framings come from one hover
// decision, so a non-matable entity lights up in neither and a triad handle in
// front occludes the entity behind it as it does in selector mode.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEffect } from 'react'
import { render, fireEvent, act } from '@testing-library/react'
import { FACE_LAYER_NAME, GIZMO_HANDLE_LAYER_NAME } from '@/picking'

const FACE = 'p1:body_0:face:2'
const OTHER_FACE = 'p1:body_0:face:3'
const FREE = 'p1:body_0:face:9'
const REF = { part: 'p1', anchor: 'a1' }
const OTHER_REF = { part: 'p1', anchor: 'a2' }

const { pipeline, fakeGl } = vi.hoisted(() => {
  const canvas = {
    width: 64,
    height: 64,
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 64, bottom: 64, width: 64, height: 64, toJSON() { return {} } }),
  }
  return {
    pipeline: {
      resolveAllSync: vi.fn(() => [] as unknown[]),
      isDirty: vi.fn(() => false),
      isDisposed: () => false,
    },
    fakeGl: { domElement: canvas },
  }
})

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children, onCreated }: { children: unknown; onCreated?: (s: unknown) => void }) => {
    useEffect(() => { onCreated?.({ gl: fakeGl, scene: {} }) }, [onCreated])
    return children as React.ReactNode
  },
}))
vi.mock('@react-three/drei', () => ({ Environment: () => null }))
vi.mock('@/picking/IdPickingDriver', () => ({
  // Named so react-hooks/rules-of-hooks sees a component, not a bare `default`.
  default: function IdPickingDriverStub({ onReady }: { onReady?: (p: unknown) => void }) {
    useEffect(() => { onReady?.(pipeline) }, [onReady])
    return null
  },
}))
vi.mock('@/components/Viewport/SceneController', () => ({ default: () => null }))
vi.mock('@/components/Viewport/EnvLight', () => ({ default: () => null, ENV_INTENSITY: 1 }))
vi.mock('@/components/Viewport/IdDebugOverlay', () => ({ default: () => null }))
vi.mock('@/components/misc/CubeGizmo', () => ({ CubeGizmoCanvas: () => null }))
vi.mock('@/components/Viewport/assembly/AnchorGizmos', () => ({
  default: ({ gizmos }: { gizmos: { key: string }[] }) => (
    <div data-testid="anchor-orbs" data-keys={gizmos.map(g => g.key).join(',')} />
  ),
}))
vi.mock('@/components/Viewport/assembly/AssemblyPartMesh', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/AssemblyBuiltin', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/AssemblyPickLayers', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/AssemblySelectionHighlight', () => ({
  default: ({ hovered, selection }: { hovered: string | null; selection: ReadonlySet<string> }) => (
    <div data-testid="brep-highlight" data-hovered={hovered ?? ''} data-selected={[...selection].join(',')} />
  ),
}))
vi.mock('@/components/Viewport/assembly/GizmoPickLayer', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/RollGuideGizmo', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/TriadGizmo', () => ({ default: () => null }))

import AssemblyViewport from '../AssemblyViewport'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'
import { installPointerEventStub } from '@/testing/pointerEventStub'

installPointerEventStub('')

beforeEach(() => {
  // rAF runs synchronously: the assembly's deferred readback resolves in the
  // same act() as the pointer move, so a test needs no frame pumping.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  pipeline.resolveAllSync.mockReset()
  pipeline.resolveAllSync.mockImplementation(() => [])
  pipeline.isDirty.mockReset()
  pipeline.isDirty.mockImplementation(() => false)
  const store = useAssemblyStore.getState()
  store.setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
  store.setActiveMateField(null)
  store.clearHover()
  store.setHoveredEntity(null)
  store.clearSelection()
  useAssemblyStore.setState({
    entityMateRefs: { [FACE]: [REF], [OTHER_FACE]: [OTHER_REF] },
    anchors: {
      p1: {
        a1: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1] },
        a2: { kind: 'plane', point: [1, 0, 0], axis: [0, 0, 1] },
      },
    },
  })
})

function move(container: HTMLElement, ctrlKey = false) {
  const root = container.firstElementChild as HTMLElement
  act(() => {
    fireEvent.pointerMove(root, { clientX: 32, clientY: 32, buttons: 0, ctrlKey })
  })
}

function hits(hitList: { layer: string; entityKey: string }[]) {
  pipeline.resolveAllSync.mockImplementation(() => hitList)
}

function armRef() {
  act(() => { useAssemblyStore.getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' }) })
}

function highlight(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="brep-highlight"]')
}

function orbs(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="anchor-orbs"]')
}

describe('AssemblyViewport aiming hover highlight', () => {
  it('highlights the matable entity alongside its anchor orbs', () => {
    hits([{ layer: FACE_LAYER_NAME, entityKey: FACE }])
    armRef()
    const { container } = render(<AssemblyViewport />)
    move(container)

    expect(useAssemblyStore.getState().hoveredEntity).toBe(FACE)
    expect(highlight(container)?.dataset.hovered).toBe(FACE)
    expect(orbs(container)?.dataset.keys).toBe('p1|a1')
  })

  it('draws neither highlight nor orbs for an entity with no mate refs', () => {
    hits([{ layer: FACE_LAYER_NAME, entityKey: FREE }])
    armRef()
    const { container } = render(<AssemblyViewport />)
    move(container)

    expect(useAssemblyStore.getState().hoveredEntity).toBeNull()
    expect(highlight(container)?.dataset.hovered).toBe('')
    expect(orbs(container)?.dataset.keys).toBe('')
  })

  it('follows the Ctrl-scoped entity, keeping highlight and orbs on one entity', () => {
    hits([
      { layer: FACE_LAYER_NAME, entityKey: FACE },
      { layer: FACE_LAYER_NAME, entityKey: OTHER_FACE },
    ])
    armRef()
    const { container } = render(<AssemblyViewport />)
    move(container, true)

    const store = useAssemblyStore.getState()
    expect(store.pickScopeEntity).toBe(FACE)
    expect(store.hoveredEntity).toBe(store.pickScopeEntity)
    expect(highlight(container)?.dataset.hovered).toBe(FACE)
    expect(orbs(container)?.dataset.keys).toBe('p1|a1')
  })

  it('keeps a gizmo handle in front from lighting up the entity behind it', () => {
    hits([
      { layer: GIZMO_HANDLE_LAYER_NAME, entityKey: 'gz:p1:x+' },
      { layer: FACE_LAYER_NAME, entityKey: FACE },
    ])
    armRef()
    const { container } = render(<AssemblyViewport />)
    move(container)

    expect(useAssemblyStore.getState().hoveredEntity).toBeNull()
    expect(highlight(container)?.dataset.hovered).toBe('')
    // The aiming hover still strips the handle for the anchor resolver.
    expect(orbs(container)?.dataset.keys).toBe('p1|a1')
  })

  it('pointer leave clears both the highlight and the aiming hover', () => {
    hits([{ layer: FACE_LAYER_NAME, entityKey: FACE }])
    armRef()
    const { container } = render(<AssemblyViewport />)
    move(container)
    expect(highlight(container)?.dataset.hovered).toBe(FACE)

    act(() => { fireEvent.pointerLeave(container.firstElementChild as HTMLElement) })

    const store = useAssemblyStore.getState()
    expect(store.hoveredEntity).toBeNull()
    expect(store.hoverHits).toEqual([])
    expect(store.pickScopeEntity).toBeNull()
    expect(highlight(container)?.dataset.hovered).toBe('')
    expect(orbs(container)?.dataset.keys).toBe('')
  })

  it('hides measurement selection while aiming but keeps it in selector mode', () => {
    hits([{ layer: FACE_LAYER_NAME, entityKey: FACE }])
    act(() => { useAssemblyStore.getState().toggleSelection(OTHER_FACE) })
    armRef()
    const { container } = render(<AssemblyViewport />)
    move(container)

    expect(highlight(container)?.dataset.selected).toBe('')
    expect(highlight(container)?.dataset.hovered).toBe(FACE)

    act(() => { useAssemblyStore.getState().setActiveMateField(null) })
    move(container)
    expect(highlight(container)?.dataset.selected).toBe(OTHER_FACE)
    expect(highlight(container)?.dataset.hovered).toBe(FACE)
  })
})
