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
    activePickField: null, modeStack: [],
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
    activePickField: null, modeStack: [],
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

  it('shows a warning name, not an error, when the feature solved partially', () => {
    // A partial fillet/chamfer built a valid solid; the row must warn in the
    // app accent rather than redden like an exception.
    const filletFeature: PartFeature = { id: 'fil1', kind: 'fillet', fillet: { edges: ['?x'], radius: 1 } }
    renderSidebar(
      [filletFeature],
      { fil1: { status: 'partial', body_id: 'body_ex1', exception: '1 edge(s) could not be applied' } },
      TEST_BODIES,
    )
    const name = screen.getByTitle('1 edge(s) could not be applied')
    expect(name.classList.contains('feature-name-warning')).toBe(true)
    expect(name.classList.contains('feature-name-error')).toBe(false)
  })

  it('shows neutral name when no solve result', () => {
    renderSidebar([extrudeFeature], undefined, undefined)
    const name = document.querySelector('.feature-name')
    expect(name?.classList.contains('feature-name-error')).toBe(false)
  })

  it('does not redden a sketch for its constraint status', () => {
    // A sketch's status is its constraint level, never 'ok'. The row must stay
    // neutral; an underconstrained sketch is the normal state of a new sketch.
    const sketchFeature: PartFeature = { id: 'sk1', kind: 'sketch' }
    renderSidebar([sketchFeature], { sk1: { status: 'underconstrained' } }, {})
    const name = document.querySelector('.feature-name')
    expect(name?.classList.contains('feature-name-error')).toBe(false)
  })

  // The row used to consult the solve result only for a hardcoded list of
  // kinds, so a kind outside it failed in complete silence: the geometry did
  // not change and nothing said why.
  it.each([
    ['delete_body', { id: 'db1', kind: 'delete_body', delete_body: { bodies: ['@gone'] } }, 'body not found'],
    ['import_step', { id: 'imp1', kind: 'import_step' }, 'STEP parse failed'],
    ['mirror', { id: 'mir1', kind: 'mirror' }, 'no mirror plane'],
    ['plane', { id: 'pl1', kind: 'plane' }, 'reference face gone'],
    ['sketch', { id: 'sk1', kind: 'sketch' }, 'plane not found'],
  ])('shows error name when a %s feature throws', (_kind, feature, message) => {
    renderSidebar([feature as PartFeature], { [(feature as PartFeature).id]: { status: 'exception', exception: message } }, {})
    expect(screen.getByTitle(message).classList.contains('feature-name-error')).toBe(true)
  })

  it('does not redden a suppressed feature', () => {
    // 'suppressed' is the user switching the feature off, and the row already
    // says so by striking the name through.
    renderSidebar([extrudeFeature], { ex1: { status: 'suppressed' } }, {})
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
