import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Sidebar } from '../../components/Sidebar'
import { getBodiesToRender } from '../../components/Viewport/bodyUtils'
import type { PartFeature, BodyResult, Mesh3D } from '../../types/cad'

const TEST_CUBE_MESH: Mesh3D = {
  vertices: [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]],
  faces: [[0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,4,5],[0,5,1],
          [1,5,6],[1,6,2],[2,6,7],[2,7,3],[3,7,4],[3,4,0]],
  normals: [],
}

const TEST_BODIES: Record<string, BodyResult> = {
  body_ex1: { id: 'body_ex1', created_by: 'ex1', modified_by: [], mesh: TEST_CUBE_MESH },
}

const extrudeFeature: PartFeature = {
  id: 'ex1',
  kind: 'extrude',
  extrude: { sketch: '$sk1', distance: 10, direction: 'normal' },
}

function makeSidebarProps(overrides: Record<string, unknown> = {}) {
  return {
    features: [] as PartFeature[],
    doc: null,
    rollbackPosition: null,
    visibleFeatures: new Set<string>(),
    editingFeatureId: null,
    selection: new Set<string>(),
    pendingPickField: null,
    planeSelectionFeatureId: null,
    onToggleSelect: vi.fn(),
    onEnterEditSketch: vi.fn(),
    onExitEditSketch: vi.fn(),
    onEnterEditFeature: vi.fn(),
    onExitEditFeature: vi.fn(),
    onToggleVisibility: vi.fn(),
    onRightClick: vi.fn(),
    onRollbackDragStart: vi.fn(),
    onMutation: vi.fn(),
    onSetRollbackPosition: vi.fn(),
    onSetPendingPickField: vi.fn(),
    onSetPlaneSelectionFeatureId: vi.fn(),
    featureTimings: {},
    ...overrides,
  }
}

describe('extrude feature name error state', () => {
  it('shows neutral name when status ok and mesh present', () => {
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      solveResults: { ex1: { status: 'ok', body_id: 'body_ex1' } },
      bodies: TEST_BODIES,
    })} />)
    const name = document.querySelector('.feature-name')
    expect(name?.classList.contains('feature-name-error')).toBe(false)
  })

  it('shows error name when status ok but no mesh (mesh_error)', () => {
    const bodiesWithError: Record<string, BodyResult> = {
      body_ex1: { id: 'body_ex1', created_by: 'ex1', modified_by: [], mesh_error: 'no shape' },
    }
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      solveResults: { ex1: { status: 'ok', body_id: 'body_ex1' } },
      bodies: bodiesWithError,
    })} />)
    const name = screen.getByTitle('no shape')
    expect(name.classList.contains('feature-name-error')).toBe(true)
  })

  it('shows error name when feature has exception', () => {
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      solveResults: { ex1: { status: 'exception', body_id: 'body_ex1', exception: 'sketch not found' } },
      bodies: TEST_BODIES,
    })} />)
    const name = screen.getByTitle('sketch not found')
    expect(name.classList.contains('feature-name-error')).toBe(true)
  })

  it('shows neutral name when no solve result', () => {
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      solveResults: undefined,
      bodies: undefined,
    })} />)
    const name = document.querySelector('.feature-name')
    expect(name?.classList.contains('feature-name-error')).toBe(false)
  })

  it('does not show error for non-extrude features', () => {
    const sketchFeature: PartFeature = { id: 'sk1', kind: 'sketch' }
    render(<Sidebar {...makeSidebarProps({
      features: [sketchFeature],
      visibleFeatures: new Set(['sk1']),
      solveResults: { sk1: { status: 'ok' } },
      bodies: {},
    })} />)
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