// The feature rows are reachable by keyboard, not only by a pointer click.
// Without this, a keyboard-only user cannot select a feature in the part editor;
// the AssemblyTree rows already carry the role="option" pattern.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from '@/components/layout/Sidebar'
import type { PartFeature } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { PartEditorProvider } from '@/contexts/PartEditorContext'
import type { PartEditorCallbacks } from '@/contexts/PartEditorContext'
import { builtinSelectionId } from '@/components/Geometry3D/utils'

function makeCallbacks(overrides: Partial<PartEditorCallbacks> = {}): PartEditorCallbacks {
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
    ...overrides,
  }
}

function renderSidebar(callbacks: PartEditorCallbacks = makeCallbacks()) {
  return render(
    <PartEditorProvider value={callbacks}>
      <Sidebar />
    </PartEditorProvider>
  )
}

const builtInFeatures: PartFeature[] = [
  { id: 'Origin', kind: 'origin' },
  { id: 'Top', kind: 'plane' },
]

const extrudeFeature: PartFeature = {
  id: 'ex1',
  kind: 'extrude',
  extrude: { sketch: '$sk1', distance: 10, direction: 'normal' },
}

function setupStore(features: PartFeature[]) {
  usePartEditorStore.setState({
    features,
    rollbackPosition: null,
    visibleFeatures: new Set(features.map(f => f.id)),
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
    modeStack: [],
  })
}

beforeEach(() => {
  setupStore([])
})

describe('FeatureTree keyboard reachability', () => {
  it('exposes the rows as tabbable options', () => {
    setupStore([...builtInFeatures, extrudeFeature])
    const { container } = renderSidebar()
    const options = container.querySelectorAll('.feature-item[role="option"]')
    expect(options).toHaveLength(3)
    for (const option of options) {
      expect(option.getAttribute('tabindex')).toBe('0')
    }
  })

  it('selects the feature on Enter', () => {
    const onToggleSelect = vi.fn()
    setupStore([...builtInFeatures, extrudeFeature])
    renderSidebar(makeCallbacks({ onToggleSelect }))
    const row = screen.getByText('ex1').closest('.feature-item') as HTMLElement
    expect(row.getAttribute('aria-selected')).toBe('false')

    row.focus()
    fireEvent.keyDown(row, { key: 'Enter' })

    expect(onToggleSelect).toHaveBeenCalledWith('@ex1')
  })

  it('reflects aria-selected from the store selection', () => {
    setupStore([...builtInFeatures, extrudeFeature])
    useSketchEditorStore.setState({ normalSelection: new Set(['@ex1']) })
    renderSidebar()
    const row = screen.getByText('ex1').closest('.feature-item') as HTMLElement
    expect(row.getAttribute('aria-selected')).toBe('true')
  })

  it('selects the built-in feature on Space with its builtin selection id', () => {
    const onToggleSelect = vi.fn()
    setupStore([...builtInFeatures, extrudeFeature])
    renderSidebar(makeCallbacks({ onToggleSelect }))
    const row = screen.getByText('Origin').closest('.feature-item') as HTMLElement

    fireEvent.keyDown(row, { key: ' ' })

    expect(onToggleSelect).toHaveBeenCalledWith(builtinSelectionId('Origin'))
  })

  // A key event bubbling out of a control inside the row must not re-select the
  // feature: only the row itself answers Enter/Space.
  it('ignores a key event bubbling from a control inside the row', () => {
    const onToggleSelect = vi.fn()
    setupStore([...builtInFeatures, extrudeFeature])
    renderSidebar(makeCallbacks({ onToggleSelect }))
    const row = screen.getByText('ex1').closest('.feature-item') as HTMLElement
    const button = row.querySelector('button') as HTMLElement

    fireEvent.keyDown(button, { key: 'Enter' })

    expect(onToggleSelect).not.toHaveBeenCalled()
  })
})
