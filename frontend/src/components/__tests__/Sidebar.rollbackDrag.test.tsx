import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from '../Sidebar'
import type { PartFeature } from '../../types/cad'

function makeSidebarProps(overrides: Record<string, unknown> = {}) {
  return {
    features: [] as PartFeature[],
    doc: null,
    rollbackPosition: null as number | null,
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

function createDragEvent(type: string, overrides: Record<string, unknown> = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...overrides })
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      effectAllowed: '',
      dropEffect: 'move',
      setData: vi.fn(),
      getData: vi.fn((format: string) => {
        if (format === 'text/plain') return overrides.dataTransferText as string || ''
        return ''
      }),
      ...((overrides.dataTransfer as Record<string, unknown>) || {}),
    },
    configurable: true,
  })
  return event
}

const builtInFeatures: PartFeature[] = [
  { id: 'Origin', kind: 'origin' },
  { id: 'Top', kind: 'plane' },
  { id: 'Front', kind: 'plane' },
  { id: 'Right', kind: 'plane' },
]

const extrudeFeature: PartFeature = {
  id: 'ex1',
  kind: 'extrude',
  extrude: { sketch: '$sk1', distance: 10, direction: 'normal' },
}

const sketchFeature: PartFeature = {
  id: 'sk1',
  kind: 'sketch',
}

describe('rollback bar drag convergence', () => {
  it('adds dragging class to rollback bar while dragged', () => {
    const features = [...builtInFeatures, extrudeFeature]
    render(<Sidebar {...makeSidebarProps({
      features,
      rollbackPosition: 4,
      visibleFeatures: new Set(features.map(f => f.id)),
    })} />)

    const rollbackBar = screen.getByTitle('Rollback')
    fireEvent(rollbackBar, createDragEvent('dragstart'))
    expect(rollbackBar.classList.contains('dragging')).toBe(true)
  })

  it('shows drop-target-top when rollback bar dragged to top half of a feature', () => {
    const features = [...builtInFeatures, extrudeFeature]
    render(<Sidebar {...makeSidebarProps({
      features,
      rollbackPosition: 4,
      visibleFeatures: new Set(features.map(f => f.id)),
    })} />)

    const rollbackBar = screen.getByTitle('Rollback')
    const featureItem = screen.getByText('ex1').closest('.feature-item')!

    vi.spyOn(featureItem, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      left: 0,
      width: 200,
      height: 40,
      bottom: 140,
      right: 200,
      x: 0,
      y: 100,
      toJSON: () => {},
    })

    fireEvent(rollbackBar, createDragEvent('dragstart'))
    fireEvent(featureItem, createDragEvent('dragover', { clientY: 110 }))

    expect(featureItem.classList.contains('drop-target-top')).toBe(true)
    expect(featureItem.classList.contains('drop-target-bottom')).toBe(false)
  })

  it('shows drop-target-bottom when rollback bar dragged to bottom half of a feature', () => {
    const features = [...builtInFeatures, extrudeFeature]
    render(<Sidebar {...makeSidebarProps({
      features,
      rollbackPosition: 4,
      visibleFeatures: new Set(features.map(f => f.id)),
    })} />)

    const rollbackBar = screen.getByTitle('Rollback')
    const featureItem = screen.getByText('ex1').closest('.feature-item')!

    vi.spyOn(featureItem, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      left: 0,
      width: 200,
      height: 40,
      bottom: 140,
      right: 200,
      x: 0,
      y: 100,
      toJSON: () => {},
    })

    fireEvent(rollbackBar, createDragEvent('dragstart'))
    fireEvent(featureItem, createDragEvent('dragover', { clientY: 130 }))

    expect(featureItem.classList.contains('drop-target-bottom')).toBe(true)
    expect(featureItem.classList.contains('drop-target-top')).toBe(false)
  })

  it('calls onSetRollbackPosition with correct index on rollback bar drop', () => {
    const onSetRollbackPosition = vi.fn()
    const features = [...builtInFeatures, extrudeFeature]
    render(<Sidebar {...makeSidebarProps({
      features,
      rollbackPosition: 4,
      visibleFeatures: new Set(features.map(f => f.id)),
      onSetRollbackPosition,
    })} />)

    const rollbackBar = screen.getByTitle('Rollback')
    const featureItem = screen.getByText('ex1').closest('.feature-item')!

    vi.spyOn(featureItem, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      left: 0,
      width: 200,
      height: 40,
      bottom: 140,
      right: 200,
      x: 0,
      y: 100,
      toJSON: () => {},
    })

    fireEvent(rollbackBar, createDragEvent('dragstart'))
    fireEvent(featureItem, createDragEvent('dragover', { clientY: 130 }))
    fireEvent(featureItem, createDragEvent('drop'))

    expect(onSetRollbackPosition).toHaveBeenCalledWith(5)
  })

  it('does not highlight built-in features during rollback bar drag', () => {
    const features = [...builtInFeatures, extrudeFeature]
    render(<Sidebar {...makeSidebarProps({
      features,
      rollbackPosition: 1,
      visibleFeatures: new Set(features.map(f => f.id)),
    })} />)

    const rollbackBars = screen.getAllByTitle('Rollback')
    const originItem = screen.getByText('Origin').closest('.feature-item')!

    vi.spyOn(originItem, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      left: 0,
      width: 200,
      height: 40,
      bottom: 140,
      right: 200,
      x: 0,
      y: 100,
      toJSON: () => {},
    })

    fireEvent(rollbackBars[0], createDragEvent('dragstart'))
    fireEvent(originItem, createDragEvent('dragover', { clientY: 110 }))

    expect(originItem.classList.contains('drop-target-top')).toBe(false)
    expect(originItem.classList.contains('drop-target-bottom')).toBe(false)
  })

  it('still reorders features when dragging a feature item', () => {
    const onMutation = vi.fn()
    const features = [...builtInFeatures, sketchFeature, extrudeFeature]
    render(<Sidebar {...makeSidebarProps({
      features,
      rollbackPosition: 6,
      visibleFeatures: new Set(features.map(f => f.id)),
      onMutation,
    })} />)

    const sketchItem = screen.getByText('sk1').closest('.feature-item')!
    const extrudeItem = screen.getByText('ex1').closest('.feature-item')!

    vi.spyOn(extrudeItem, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      left: 0,
      width: 200,
      height: 40,
      bottom: 140,
      right: 200,
      x: 0,
      y: 100,
      toJSON: () => {},
    })

    fireEvent(sketchItem, createDragEvent('dragstart', { dataTransferText: 'sk1' }))
    fireEvent(extrudeItem, createDragEvent('dragover', { clientY: 110 }))
    fireEvent(extrudeItem, createDragEvent('drop', { dataTransferText: 'sk1' }))

    expect(onMutation).toHaveBeenCalledWith({
      type: 'reorder_features',
      featureId: 'sk1',
      toIndex: 5,
    })
  })

  it('end-of-list rollback bar can be dragged to set rollback to end', () => {
    const onSetRollbackPosition = vi.fn()
    const features = [...builtInFeatures, extrudeFeature]
    render(<Sidebar {...makeSidebarProps({
      features,
      rollbackPosition: 5,
      visibleFeatures: new Set(features.map(f => f.id)),
      onSetRollbackPosition,
    })} />)

    const rollbackBars = screen.getAllByTitle('Rollback')
    const lastRollbackBar = rollbackBars[rollbackBars.length - 1]

    fireEvent(lastRollbackBar, createDragEvent('dragstart'))
    fireEvent(lastRollbackBar, createDragEvent('dragover'))
    fireEvent(lastRollbackBar, createDragEvent('drop'))

    expect(onSetRollbackPosition).toHaveBeenCalledWith(5)
  })
})
