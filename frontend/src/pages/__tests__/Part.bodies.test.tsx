import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Sidebar } from '@/components/layout/Sidebar'
import { getBodiesToRender } from '@/components/Viewport/bodyUtils'
import type { PartFeature, BodyResult, Mesh3D } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { PartEditorProvider } from '@/contexts/PartEditorContext'
import type { PartEditorCallbacks } from '@/contexts/PartEditorContext'

const TEST_CUBE_MESH: Mesh3D = {
  vertices: [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]],
  faces: [[0,1,2],[0,2,3],[4,5,6],[4,6,7],[0,4,5],[0,5,1],[1,5,6],[1,6,2],[2,6,7],[2,7,3],[3,7,4],[3,4,0]],
}

const TEST_BODIES: Record<string, BodyResult> = {
  body_ex1: { id: 'body_ex1', created_by: 'ex1', modified_by: [], mesh: TEST_CUBE_MESH },
}

const extrudeFeature: PartFeature = {
  id: 'ex1',
  kind: 'extrude',
  extrude: { sketch: '$sk1', distance: 10, direction: 'normal' },
}

function makeCallbacks(): PartEditorCallbacks {
  return {
    onToggleSelect: vi.fn(),
    onEnterEditSketch: vi.fn(),
    onExitEditSketch: vi.fn(),
    onEnterEditFeature: vi.fn(),
    onExitEditFeature: vi.fn(),
    onEditCommit: vi.fn(),
    onEditCancel: vi.fn(),
    onToggleVisibility: vi.fn(),
    onRightClick: vi.fn(),
    onMutation: vi.fn(),
    onSetRollbackPosition: vi.fn(),
  }
}

function renderSidebar(features: PartFeature[], solveResults?: Record<string, unknown>, bodies?: Record<string, BodyResult | undefined>) {
  usePartEditorStore.setState({
    features,
    visibleFeatures: new Set(features.map(f => f.id)),
    editingFeatureId: null,
    rollbackPosition: null,
    doc: null,
    visibleBodies: new Set(),
    partLabels: {},
    solveResults: solveResults ?? {},
    bodies: (bodies ?? {}) as Record<string, BodyResult>,
    isRebuilding: false,
    featureTimings: {},
  })
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    activePickField: null,
  })
  return render(
    <PartEditorProvider value={makeCallbacks()}>
      <Sidebar />
    </PartEditorProvider>
  )
}

beforeEach(() => {
  usePartEditorStore.setState({
    features: [],
    rollbackPosition: null,
    visibleFeatures: new Set(),
    editingFeatureId: null,
    doc: null,
    visibleBodies: new Set(),
    partLabels: {},
    solveResults: {},
    bodies: {},
    isRebuilding: false,
    featureTimings: {},
  })
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    activePickField: null,
  })
})

describe('extrude feature name error state', () => {
  it('shows neutral name when status ok and mesh present', () => {
    renderSidebar(
      [extrudeFeature],
      { ex1: { status: 'ok', body_id: 'body_ex1' } },
      TEST_BODIES,
    )
    const name = document.querySelector('.feature-name')
    expect(name?.classList.contains('feature-name-error')).toBe(false)
  })

  it('shows error name when status ok but no mesh (mesh_error)', () => {
    const bodiesWithError: Record<string, BodyResult> = {
      body_ex1: { id: 'body_ex1', created_by: 'ex1', modified_by: [], mesh_error: 'no shape' },
    }
    renderSidebar(
      [extrudeFeature],
      { ex1: { status: 'ok', body_id: 'body_ex1' } },
      bodiesWithError,
    )
    const name = screen.getByTitle('no shape')
    expect(name.classList.contains('feature-name-error')).toBe(true)
  })

  it('shows error name when feature has exception', () => {
    renderSidebar(
      [extrudeFeature],
      { ex1: { status: 'exception', body_id: 'body_ex1', exception: 'sketch not found' } },
      TEST_BODIES,
    )
    const name = screen.getByTitle('sketch not found')
    expect(name.classList.contains('feature-name-error')).toBe(true)
  })

  it('shows neutral name when no solve result', () => {
    renderSidebar([extrudeFeature], undefined, undefined)
    const name = document.querySelector('.feature-name')
    expect(name?.classList.contains('feature-name-error')).toBe(false)
  })

  it('does not show error for non-extrude features', () => {
    const sketchFeature: PartFeature = { id: 'sk1', kind: 'sketch' }
    renderSidebar([sketchFeature], { sk1: { status: 'ok' } }, {})
    const name = document.querySelector('.feature-name')
    expect(name?.classList.contains('feature-name-error')).toBe(false)
  })
})

describe('no filter-by-kind for bodies', () => {
  it('getBodiesToRender iterates Object.entries(bodies), not features.filter(kind)', () => {
    const src = getBodiesToRender.toString()
    expect(src).toContain('Object.entries')
    expect(src).toContain('bodies')
    expect(/bodies.*filter.*kind/.test(src)).toBe(false)
  })
})
