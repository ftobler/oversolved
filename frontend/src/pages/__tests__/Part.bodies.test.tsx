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
    fieldPickState: null,
    planeSelectionFeatureId: null,
    onToggleSelect: vi.fn(),
    onEnterEditSketch: vi.fn(),
    onExitEditSketch: vi.fn(),
    onToggleVisibility: vi.fn(),
    onRightClick: vi.fn(),
    onRollbackDragStart: vi.fn(),
    onRollbackDragOver: vi.fn(),
    onRollbackDrop: vi.fn(),
    onMutation: vi.fn(),
    onSetRollbackPosition: vi.fn(),
    onSetEditingFeatureId: vi.fn(),
    onSetFieldPickState: vi.fn(),
    onSetPlaneSelectionFeatureId: vi.fn(),
    ...overrides,
  }
}

describe('extrude status dot', () => {
  it('shows green dot when status ok and mesh present', () => {
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      solveResults: { ex1: { status: 'ok', body_id: 'body_ex1' } },
      bodies: TEST_BODIES,
    })} />)
    const dot = screen.getByTitle('')
    expect(dot.classList.contains('green')).toBe(true)
    expect(dot.classList.contains('feature-status-dot')).toBe(true)
  })

  it('shows orange dot when status ok but no mesh (mesh_error)', () => {
    const bodiesWithError: Record<string, BodyResult> = {
      body_ex1: { id: 'body_ex1', created_by: 'ex1', modified_by: [], mesh_error: 'no shape' },
    }
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      solveResults: { ex1: { status: 'ok', body_id: 'body_ex1' } },
      bodies: bodiesWithError,
    })} />)
    const dot = screen.getByTitle('no shape')
    expect(dot.classList.contains('orange')).toBe(true)
  })

  it('shows red dot when feature has exception', () => {
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      solveResults: { ex1: { status: 'exception', body_id: 'body_ex1', exception: 'sketch not found' } },
      bodies: TEST_BODIES,
    })} />)
    const dot = screen.getByTitle('sketch not found')
    expect(dot.classList.contains('red')).toBe(true)
  })

  it('shows grey dot when no solve result', () => {
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      solveResults: undefined,
      bodies: undefined,
    })} />)
    const dot = screen.getByTitle('')
    expect(dot.classList.contains('grey')).toBe(true)
  })

  it('does not show status dot for non-extrude features', () => {
    const sketchFeature: PartFeature = { id: 'sk1', kind: 'sketch' }
    render(<Sidebar {...makeSidebarProps({
      features: [sketchFeature],
      visibleFeatures: new Set(['sk1']),
      solveResults: { sk1: { status: 'ok' } },
      bodies: {},
    })} />)
    const dots = document.querySelectorAll('.feature-status-dot')
    expect(dots.length).toBe(0)
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