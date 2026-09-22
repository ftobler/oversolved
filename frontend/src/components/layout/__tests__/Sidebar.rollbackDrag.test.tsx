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

// The rollback bar rides on raw pointer events (native HTML5 drag drops the
// release when a rebuild stalls the main thread), so drive it the way a browser
// would: press the bar, move the pointer, release it anywhere on the page.
function grabRollback(bar: Element) {
  fireEvent(bar, new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
}

function movePointer(clientY: number) {
  fireEvent(window, new MouseEvent('pointermove', { clientY }))
}

function releasePointer(clientY: number) {
  fireEvent(window, new MouseEvent('pointerup', { clientY }))
}

// jsdom reports a zero rect for everything, but the drop-slot maths needs real
// rows: lay the feature items out as a 40px stack starting at y = 0.
function layoutFeatureRows() {
  document.querySelectorAll('.feature-item').forEach((el, i) => {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      top: i * 40,
      bottom: i * 40 + 40,
      height: 40,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: i * 40,
      toJSON: () => {},
    })
  })
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

function setupStore(features: PartFeature[], rollbackPosition: number | null) {
  usePartEditorStore.setState({
    features,
    rollbackPosition,
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

describe('rollback bar drag convergence', () => {
  it('adds dragging class to rollback bar while dragged', () => {
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 4)
    renderSidebar()

    const rollbackBar = screen.getByTitle('Rollback')
    grabRollback(rollbackBar)
    expect(rollbackBar.classList.contains('dragging')).toBe(true)
  })

  it('shows drop-target-top when rollback bar dragged to top half of a feature', () => {
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 4)
    renderSidebar()
    layoutFeatureRows()

    const rollbackBar = screen.getByTitle('Rollback')
    const featureItem = screen.getByText('ex1').closest('.feature-item')!

    grabRollback(rollbackBar)
    movePointer(170)  // upper half of ex1 (row 4 spans 160..200)

    expect(featureItem.classList.contains('drop-target-top')).toBe(true)
    expect(featureItem.classList.contains('drop-target-bottom')).toBe(false)
  })

  it('shows drop-target-bottom when rollback bar dragged to bottom half of a feature', () => {
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 4)
    renderSidebar()
    layoutFeatureRows()

    const rollbackBar = screen.getByTitle('Rollback')
    const featureItem = screen.getByText('ex1').closest('.feature-item')!

    grabRollback(rollbackBar)
    movePointer(190)  // lower half of ex1

    expect(featureItem.classList.contains('drop-target-bottom')).toBe(true)
    expect(featureItem.classList.contains('drop-target-top')).toBe(false)
  })

  it('calls onSetRollbackPosition with correct index on rollback bar release', () => {
    const onSetRollbackPosition = vi.fn()
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 4)
    renderSidebar(makeCallbacks({ onSetRollbackPosition }))
    layoutFeatureRows()

    grabRollback(screen.getByTitle('Rollback'))
    movePointer(190)
    releasePointer(190)

    expect(onSetRollbackPosition).toHaveBeenCalledWith(5)
  })

  it('releases the rollback bar while a rebuild is in progress', () => {
    // Native drag-and-drop lost the release when applying a finished rebuild
    // blocked the main thread past the last dragover, so the bar could not be
    // let go mid-rebuild. Pointer events must commit regardless.
    const onSetRollbackPosition = vi.fn()
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 5)
    usePartEditorStore.setState({ isRebuilding: true })
    renderSidebar(makeCallbacks({ onSetRollbackPosition }))
    layoutFeatureRows()

    grabRollback(screen.getByTitle('Rollback'))
    movePointer(170)
    releasePointer(170)

    expect(onSetRollbackPosition).toHaveBeenCalledWith(4)
    expect(screen.getByTitle('Rollback').classList.contains('dragging')).toBe(false)
  })

  it('abandons the drag on Escape without moving the bar', () => {
    const onSetRollbackPosition = vi.fn()
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 5)
    renderSidebar(makeCallbacks({ onSetRollbackPosition }))
    layoutFeatureRows()

    const rollbackBar = screen.getByTitle('Rollback')
    grabRollback(rollbackBar)
    movePointer(170)
    fireEvent.keyDown(window, { key: 'Escape' })
    releasePointer(170)

    expect(onSetRollbackPosition).not.toHaveBeenCalled()
    expect(rollbackBar.classList.contains('dragging')).toBe(false)
  })

  it('does not highlight built-in features during rollback bar drag', () => {
    const onSetRollbackPosition = vi.fn()
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 1)
    renderSidebar(makeCallbacks({ onSetRollbackPosition }))
    layoutFeatureRows()

    const originItem = screen.getByText('Origin').closest('.feature-item')!

    grabRollback(screen.getAllByTitle('Rollback')[0])
    movePointer(10)  // over Origin, which the bar may never be parked above
    expect(originItem.classList.contains('drop-target-top')).toBe(false)
    expect(originItem.classList.contains('drop-target-bottom')).toBe(false)

    releasePointer(10)
    expect(onSetRollbackPosition).toHaveBeenCalledWith(4)  // clamped past the built-ins
  })

  it('still reorders features when dragging a feature item', () => {
    const onMutation = vi.fn()
    const features = [...builtInFeatures, sketchFeature, extrudeFeature]
    setupStore(features, 6)
    renderSidebar(makeCallbacks({ onMutation }))

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

  it('renders the rollback bar at the end when rollbackPosition is null', () => {
    // Edit exit resets rollbackPosition to null, meaning "end of stack".
    // The bar must still be drawn there, not vanish.
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, null)
    renderSidebar()

    expect(screen.getByTitle('Rollback')).toBeInTheDocument()
  })

  it('renders the rollback bar when rollbackPosition is stale past the end', () => {
    // Deleting features out of order can leave rollbackPosition > features.length
    // until the owner clamps it. Render must clamp to the end, not draw nothing.
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 99)
    renderSidebar()

    expect(screen.getByTitle('Rollback')).toBeInTheDocument()
  })

  it('rollback bar is not draggable while a feature is being edited', () => {
    const onSetRollbackPosition = vi.fn()
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 5)
    usePartEditorStore.setState({ editingFeatureId: 'ex1' })
    renderSidebar(makeCallbacks({ onSetRollbackPosition }))
    layoutFeatureRows()

    const rollbackBar = screen.getByTitle('Rollback')
    grabRollback(rollbackBar)
    expect(rollbackBar.classList.contains('dragging')).toBe(false)

    releasePointer(170)
    expect(onSetRollbackPosition).not.toHaveBeenCalled()
  })

  it('mid-list rollback bar is not draggable while a feature is being edited', () => {
    const onSetRollbackPosition = vi.fn()
    const features = [...builtInFeatures, sketchFeature, extrudeFeature]
    setupStore(features, 5)
    usePartEditorStore.setState({ editingFeatureId: 'sk1' })
    renderSidebar(makeCallbacks({ onSetRollbackPosition }))
    layoutFeatureRows()

    const rollbackBar = screen.getByTitle('Rollback')
    grabRollback(rollbackBar)
    expect(rollbackBar.classList.contains('dragging')).toBe(false)

    releasePointer(170)
    expect(onSetRollbackPosition).not.toHaveBeenCalled()
  })

  it('dragging the bar below every feature parks it at the end', () => {
    const onSetRollbackPosition = vi.fn()
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 4)
    renderSidebar(makeCallbacks({ onSetRollbackPosition }))
    layoutFeatureRows()

    grabRollback(screen.getByTitle('Rollback'))
    releasePointer(500)  // below every feature row

    expect(onSetRollbackPosition).toHaveBeenCalledWith(5)
  })

  it('a click that does not move the bar commits nothing', () => {
    // The bar is 10px tall and sits inside a click-happy tree; a stray press
    // must not dirty the document with a rollback it never moved.
    const onSetRollbackPosition = vi.fn()
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 5)
    renderSidebar(makeCallbacks({ onSetRollbackPosition }))
    layoutFeatureRows()

    grabRollback(screen.getByTitle('Rollback'))
    releasePointer(500)  // still past the last row, where the bar already is

    expect(onSetRollbackPosition).not.toHaveBeenCalled()
  })
})

