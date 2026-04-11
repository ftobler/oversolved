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
    expect(screen.getByRole('combobox')).toBeInTheDocument()
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
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'symmetric' } })
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
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'reverse' } })
    expect(onMutation).toHaveBeenCalledWith<[Mutation]>({
      type: 'set_extrude_direction',
      featureId: 'ex1',
      direction: 'reverse',
    })
  })
})

// 4: sketch pick - clicking a sketch row while kind === 'sketch' pick is active
describe('sketch pick resolution', () => {
  it('dispatches set_extrude_sketch and clears fieldPickState when sketch row is clicked', () => {
    const onMutation = vi.fn()
    const onSetFieldPickState = vi.fn()
    const sketchFeature: PartFeature = { id: 'sk1', kind: 'sketch' }
    render(<Sidebar {...makeSidebarProps({
      features: [extrudeFeature, sketchFeature],
      visibleFeatures: new Set(['ex1', 'sk1']),
      editingFeatureId: 'ex1',
      fieldPickState: { featureId: 'ex1', field: 'sketch', kind: 'sketch' },
      onMutation,
      onSetFieldPickState,
    })} />)
    // Click the feature row li, not the inner name span (which stops propagation for renaming).
    const sketchRow = screen.getByText('sk1').closest('li')!
    fireEvent.click(sketchRow)
    expect(onMutation).toHaveBeenCalledWith<[Mutation]>({
      type: 'set_extrude_sketch',
      featureId: 'ex1',
      sketchQuery: '$sk1',
    })
    expect(onSetFieldPickState).toHaveBeenCalledWith(null)
  })
})
