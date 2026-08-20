import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from '@/components/layout/Sidebar'
import type { PartFeature } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { PartEditorProvider } from '@/contexts/PartEditorContext'
import type { PartEditorCallbacks } from '@/contexts/PartEditorContext'

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

function setupStore(features: PartFeature[], editingFeatureId: string | null = null) {
  usePartEditorStore.setState({
    features,
    rollbackPosition: null,
    visibleFeatures: new Set(features.map(f => f.id)),
    editingFeatureId,
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

describe('FeatureTree double-click to edit', () => {
  it('double-clicking an extrude row opens it via onEnterEditFeature', () => {
    const onEnterEditFeature = vi.fn()
    const onEnterEditSketch = vi.fn()
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features)
    renderSidebar(makeCallbacks({ onEnterEditFeature, onEnterEditSketch }))

    const extrudeItem = screen.getByText('ex1').closest('.feature-item')!
    fireEvent.doubleClick(extrudeItem)

    expect(onEnterEditFeature).toHaveBeenCalledTimes(1)
    expect(onEnterEditFeature).toHaveBeenCalledWith('ex1')
    expect(onEnterEditSketch).not.toHaveBeenCalled()
  })

  it('double-clicking a sketch row opens it via onEnterEditSketch', () => {
    const onEnterEditFeature = vi.fn()
    const onEnterEditSketch = vi.fn()
    const features = [...builtInFeatures, sketchFeature]
    setupStore(features)
    renderSidebar(makeCallbacks({ onEnterEditFeature, onEnterEditSketch }))

    const sketchItem = screen.getByText('sk1').closest('.feature-item')!
    fireEvent.doubleClick(sketchItem)

    expect(onEnterEditSketch).toHaveBeenCalledTimes(1)
    expect(onEnterEditSketch).toHaveBeenCalledWith('sk1')
    expect(onEnterEditFeature).not.toHaveBeenCalled()
  })

  it('double-clicking a built-in (Origin) row calls neither handler', () => {
    const onEnterEditFeature = vi.fn()
    const onEnterEditSketch = vi.fn()
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features)
    renderSidebar(makeCallbacks({ onEnterEditFeature, onEnterEditSketch }))

    const originItem = screen.getByText('Origin').closest('.feature-item')!
    fireEvent.doubleClick(originItem)

    expect(onEnterEditFeature).not.toHaveBeenCalled()
    expect(onEnterEditSketch).not.toHaveBeenCalled()
  })

  it('double-clicking the feature already being edited does not open again', () => {
    const onEnterEditFeature = vi.fn()
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 'ex1')  // ex1 is already the editing feature
    renderSidebar(makeCallbacks({ onEnterEditFeature }))

    const extrudeItem = screen.getByText('ex1').closest('.feature-item')!
    fireEvent.doubleClick(extrudeItem)

    expect(onEnterEditFeature).not.toHaveBeenCalled()
  })
})
