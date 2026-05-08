import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from '../Sidebar'
import type { PartFeature, Mutation } from '../../types/cad'

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

const extrudeFeature: PartFeature = {
  id: 'ex1',
  kind: 'extrude',
  extrude: { sketch: '$sk1', distance: 10, direction: 'normal' },
}

// 1: ExtrudeEditor renders distance input and direction select
describe('ExtrudeEditor renders in Sidebar', () => {
  it('shows distance input and direction select when extrude feature is being edited', () => {
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      editingFeatureId: 'ex1',
    })} />)
    expect(screen.getByRole('spinbutton')).toBeInTheDocument()
    expect(screen.getAllByRole('combobox')).toHaveLength(2)
  })

  it('does not render editor when editingFeatureId is null', () => {
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      editingFeatureId: null,
    })} />)
    expect(screen.queryByRole('spinbutton')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})

// 2: distance input blur dispatches set_extrude_distance
describe('distance input', () => {
  it('dispatches set_extrude_distance on blur with valid value', () => {
    const onMutation = vi.fn()
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      editingFeatureId: 'ex1',
      onMutation,
    })} />)
    const input = screen.getByRole('spinbutton') as HTMLInputElement
    fireEvent.change(input, { target: { value: '25' } })
    fireEvent.blur(input)
    expect(onMutation).toHaveBeenCalledWith<[Mutation]>({
      type: 'set_extrude_distance',
      featureId: 'ex1',
      distance: 25,
    })
  })

  it('does not dispatch for non-positive value', () => {
    const onMutation = vi.fn()
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      editingFeatureId: 'ex1',
      onMutation,
    })} />)
    const input = screen.getByRole('spinbutton') as HTMLInputElement
    fireEvent.change(input, { target: { value: '-5' } })
    fireEvent.blur(input)
    expect(onMutation).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'set_extrude_distance' }))
  })

  it('dispatches on Enter key (keyDown then blur)', () => {
    const onMutation = vi.fn()
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      editingFeatureId: 'ex1',
      onMutation,
    })} />)
    const input = screen.getByRole('spinbutton') as HTMLInputElement
    fireEvent.change(input, { target: { value: '30' } })
    // jsdom does not auto-fire blur when .blur() is called programmatically,
    // so fire keyDown then blur explicitly to simulate the handler's behaviour.
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(onMutation).toHaveBeenCalledWith<[Mutation]>({
      type: 'set_extrude_distance',
      featureId: 'ex1',
      distance: 30,
    })
  })
})

// 3: direction select change dispatches set_extrude_direction
describe('direction select', () => {
  it('dispatches set_extrude_direction on change to symmetric', () => {
    const onMutation = vi.fn()
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      editingFeatureId: 'ex1',
      onMutation,
    })} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Direction' }), { target: { value: 'symmetric' } })
    expect(onMutation).toHaveBeenCalledWith<[Mutation]>({
      type: 'set_extrude_direction',
      featureId: 'ex1',
      direction: 'symmetric',
    })
  })

  it('dispatches set_extrude_direction on change to reverse', () => {
    const onMutation = vi.fn()
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      editingFeatureId: 'ex1',
      onMutation,
    })} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Direction' }), { target: { value: 'reverse' } })
    expect(onMutation).toHaveBeenCalledWith<[Mutation]>({
      type: 'set_extrude_direction',
      featureId: 'ex1',
      direction: 'reverse',
    })
  })
})

// 4: operation select change dispatches set_extrude_operation
describe('operation select', () => {
  it('dispatches set_extrude_operation on change to cut', () => {
    const onMutation = vi.fn()
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      editingFeatureId: 'ex1',
      onMutation,
    })} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Operation' }), { target: { value: 'cut' } })
    expect(onMutation).toHaveBeenCalledWith<[Mutation]>({
      type: 'set_extrude_operation',
      featureId: 'ex1',
      operation: 'cut',
    })
  })

  it('dispatches set_extrude_operation on change to add', () => {
    const onMutation = vi.fn()
    const cutFeature: PartFeature = {
      id: 'ex1',
      kind: 'extrude',
      extrude: { sketch: '$sk1', distance: 10, direction: 'normal', operation: 'cut' },
    }
    render(<Sidebar {...makeSidebarProps({
      features: [cutFeature],
      visibleFeatures: new Set(['ex1']),
      editingFeatureId: 'ex1',
      onMutation,
    })} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Operation' }), { target: { value: 'add' } })
    expect(onMutation).toHaveBeenCalledWith<[Mutation]>({
      type: 'set_extrude_operation',
      featureId: 'ex1',
      operation: 'add',
    })
  })
})

// 5: merge target PickChip visibility and interaction
describe('merge target PickChip', () => {
  it('is shown for add operation', () => {
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      editingFeatureId: 'ex1',
    })} />)
    expect(screen.getByText('Merge Target')).toBeInTheDocument()
  })

  it('is shown for cut operation', () => {
    const cutFeature: PartFeature = {
      id: 'ex1', kind: 'extrude',
      extrude: { sketch: '$sk1', distance: 10, operation: 'cut' },
    }
    render(<Sidebar {...makeSidebarProps({
      features: [cutFeature],
      visibleFeatures: new Set(['ex1']),
      editingFeatureId: 'ex1',
    })} />)
    expect(screen.getByText('Merge Target')).toBeInTheDocument()
  })

  it('is hidden for new operation', () => {
    const newFeature: PartFeature = {
      id: 'ex1', kind: 'extrude',
      extrude: { sketch: '$sk1', distance: 10, operation: 'new' },
    }
    render(<Sidebar {...makeSidebarProps({
      features: [newFeature],
      visibleFeatures: new Set(['ex1']),
      editingFeatureId: 'ex1',
    })} />)
    expect(screen.queryByText('Merge Target')).toBeNull()
  })

  it('shows (all bodies) when no merge_target is set', () => {
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      editingFeatureId: 'ex1',
    })} />)
    expect(screen.getByText('(all bodies)')).toBeInTheDocument()
  })

  it('activates pick mode on chip click', () => {
    const onSetPendingPickField = vi.fn()
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      editingFeatureId: 'ex1',
      onSetPendingPickField,
    })} />)
    fireEvent.click(screen.getByText('(all bodies)'))
    expect(onSetPendingPickField).toHaveBeenCalledWith({ featureId: 'ex1', field: 'merge_target' })
  })

  it('deactivates pick mode when chip clicked while already picking', () => {
    const onSetPendingPickField = vi.fn()
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature],
      visibleFeatures: new Set(['ex1']),
      editingFeatureId: 'ex1',
      pendingPickField: { featureId: 'ex1', field: 'merge_target' },
      onSetPendingPickField,
    })} />)
    fireEvent.click(screen.getByText('(all bodies)'))
    expect(onSetPendingPickField).toHaveBeenCalledWith(null)
  })
})

// 6: sketch pick - clicking a sketch row while pendingPickField.field === 'sketch' is active
describe('sketch pick resolution', () => {
  it('dispatches set_extrude_sketch and clears pendingPickField when sketch row is clicked', () => {
    const onMutation = vi.fn()
    const onSetPendingPickField = vi.fn()
    const sketchFeature: PartFeature = { id: 'sk1', kind: 'sketch' }
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature, sketchFeature],
      visibleFeatures: new Set(['ex1', 'sk1']),
      editingFeatureId: 'ex1',
      pendingPickField: { featureId: 'ex1', field: 'sketch' },
      onMutation,
      onSetPendingPickField,
    })} />)
    // Click the feature row li, not the inner name span (which stops propagation for renaming).
    const sketchRow = screen.getByText((content, el) =>
      !!(content === 'sk1' && el?.classList.contains('feature-name'))
    ).closest('li')!
    fireEvent.click(sketchRow)
    expect(onMutation).toHaveBeenCalledWith<[Mutation]>({
      type: 'add_extrude_profile',
      featureId: 'ex1',
      sketchQuery: '$sk1',
    })
    // pick mode stays open after each selection
    expect(onSetPendingPickField).not.toHaveBeenCalledWith(null)
  })
})
