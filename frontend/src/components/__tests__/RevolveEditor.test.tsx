import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from '../Sidebar'
import type { PartFeature } from '../../types/cad'

function makeSidebarProps(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
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

const revolveFeature: PartFeature = {
  id: 'rev1',
  kind: 'revolve',
  revolve: { sketch: '$sk1', angle: 360 },
}

describe('merge target PickChip in RevolveEditor', () => {
  it('is shown for add operation (default)', () => {
    render(<Sidebar {...makeSidebarProps({
      features: [revolveFeature],
      visibleFeatures: new Set(['rev1']),
      editingFeatureId: 'rev1',
    })} />)
    expect(screen.getByText('Merge Target')).toBeInTheDocument()
  })

  it('is shown for cut operation', () => {
    const cutFeature: PartFeature = {
      id: 'rev1', kind: 'revolve',
      revolve: { sketch: '$sk1', angle: 360, operation: 'cut' },
    }
    render(<Sidebar {...makeSidebarProps({
      features: [cutFeature],
      visibleFeatures: new Set(['rev1']),
      editingFeatureId: 'rev1',
    })} />)
    expect(screen.getByText('Merge Target')).toBeInTheDocument()
  })

  it('is hidden for new operation', () => {
    const newFeature: PartFeature = {
      id: 'rev1', kind: 'revolve',
      revolve: { sketch: '$sk1', angle: 360, operation: 'new' },
    }
    render(<Sidebar {...makeSidebarProps({
      features: [newFeature],
      visibleFeatures: new Set(['rev1']),
      editingFeatureId: 'rev1',
    })} />)
    expect(screen.queryByText('Merge Target')).toBeNull()
  })

  it('shows (all bodies) when no merge_target set', () => {
    render(<Sidebar {...makeSidebarProps({
      features: [revolveFeature],
      visibleFeatures: new Set(['rev1']),
      editingFeatureId: 'rev1',
    })} />)
    expect(screen.getByText('(all bodies)')).toBeInTheDocument()
  })

  it('activates pick mode with hostKind revolve on chip click', () => {
    const onSetPendingPickField = vi.fn()
    render(<Sidebar {...makeSidebarProps({
      features: [revolveFeature],
      visibleFeatures: new Set(['rev1']),
      editingFeatureId: 'rev1',
      onSetPendingPickField,
    })} />)
    fireEvent.click(screen.getByText('(all bodies)'))
    expect(onSetPendingPickField).toHaveBeenCalledWith({
      featureId: 'rev1', field: 'merge_target', hostKind: 'revolve',
    })
  })

  it('deactivates pick mode when chip clicked while already picking', () => {
    const onSetPendingPickField = vi.fn()
    render(<Sidebar {...makeSidebarProps({
      features: [revolveFeature],
      visibleFeatures: new Set(['rev1']),
      editingFeatureId: 'rev1',
      pendingPickField: { featureId: 'rev1', field: 'merge_target', hostKind: 'revolve' },
      onSetPendingPickField,
    })} />)
    fireEvent.click(screen.getByText('(all bodies)'))
    expect(onSetPendingPickField).toHaveBeenCalledWith(null)
  })

})
