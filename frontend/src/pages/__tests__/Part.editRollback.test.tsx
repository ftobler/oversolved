import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from '../../components/Sidebar'
import type { PartFeature } from '../../types/cad'

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

const extrudeFeature: PartFeature = {
  id: 'ex1',
  kind: 'extrude',
  extrude: { sketch: '$sk1', distance: 10, direction: 'normal' },
}

const planeFeature: PartFeature = { id: 'pl1', kind: 'plane' }

describe('extrude edit button', () => {
  it('calls onEnterEditFeature with the feature id', () => {
    const onEnterEditFeature = vi.fn()
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      onEnterEditFeature,
    })} />)
    fireEvent.click(screen.getByTitle('Edit extrude'))
    expect(onEnterEditFeature).toHaveBeenCalledWith('ex1')
  })

  it('does not call onSetRollbackPosition directly', () => {
    const onSetRollbackPosition = vi.fn()
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      onSetRollbackPosition,
    })} />)
    fireEvent.click(screen.getByTitle('Edit extrude'))
    expect(onSetRollbackPosition).not.toHaveBeenCalled()
  })
})

describe('extrude exit button', () => {
  it('calls onExitEditFeature when closing extrude editor', () => {
    const onExitEditFeature = vi.fn()
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      editingFeatureId: 'ex1',
      onExitEditFeature,
    })} />)
    fireEvent.click(screen.getByTitle('Exit extrude editor'))
    expect(onExitEditFeature).toHaveBeenCalled()
  })

  it('does not call onSetPendingPickField directly on exit', () => {
    const onSetPendingPickField = vi.fn()
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      editingFeatureId: 'ex1',
      onSetPendingPickField,
    })} />)
    fireEvent.click(screen.getByTitle('Exit extrude editor'))
    expect(onSetPendingPickField).not.toHaveBeenCalled()
  })
})

describe('plane edit button', () => {
  it('calls onEnterEditFeature with the feature id', () => {
    const onEnterEditFeature = vi.fn()
    render(<Sidebar {...makeSidebarProps({
      features: [planeFeature],
      visibleFeatures: new Set(['pl1']),
      onEnterEditFeature,
    })} />)
    fireEvent.click(screen.getByTitle('Edit plane'))
    expect(onEnterEditFeature).toHaveBeenCalledWith('pl1')
  })

  it('does not call onSetRollbackPosition directly', () => {
    const onSetRollbackPosition = vi.fn()
    render(<Sidebar {...makeSidebarProps({
      features: [planeFeature],
      visibleFeatures: new Set(['pl1']),
      onSetRollbackPosition,
    })} />)
    fireEvent.click(screen.getByTitle('Edit plane'))
    expect(onSetRollbackPosition).not.toHaveBeenCalled()
  })
})

describe('plane exit button', () => {
  it('calls onExitEditFeature when closing plane editor', () => {
    const onExitEditFeature = vi.fn()
    render(<Sidebar {...makeSidebarProps({
      features: [planeFeature],
      visibleFeatures: new Set(['pl1']),
      editingFeatureId: 'pl1',
      onExitEditFeature,
    })} />)
    fireEvent.click(screen.getByTitle('Exit plane editor'))
    expect(onExitEditFeature).toHaveBeenCalled()
  })
})
