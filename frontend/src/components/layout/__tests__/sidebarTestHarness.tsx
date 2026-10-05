// Shared harness for the Sidebar/FeatureTree layout tests: callbacks, render
// wrapper, store fixtures and the pointer/drag event helpers.
import { vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { Sidebar } from '@/components/layout/Sidebar'
import type { PartFeature } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { PartEditorProvider } from '@/contexts/PartEditorContext'
import type { PartEditorCallbacks } from '@/contexts/PartEditorContext'

export function makeCallbacks(overrides: Partial<PartEditorCallbacks> = {}): PartEditorCallbacks {
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

export function renderSidebar(callbacks: PartEditorCallbacks = makeCallbacks()) {
  return render(
    <PartEditorProvider value={callbacks}>
      <Sidebar />
    </PartEditorProvider>
  )
}

export const builtInFeatures: PartFeature[] = [
  { id: 'Origin', kind: 'origin' },
  { id: 'Top', kind: 'plane' },
  { id: 'Front', kind: 'plane' },
  { id: 'Right', kind: 'plane' },
]

export const extrudeFeature: PartFeature = {
  id: 'ex1',
  kind: 'extrude',
  extrude: { sketch: '$sk1', distance: 10, direction: 'normal' },
}

export const sketchFeature: PartFeature = {
  id: 'sk1',
  kind: 'sketch',
}

// Reset both stores to the empty state the tests start from.
export function resetStores() {
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
}

function seedFeatures(features: PartFeature[]) {
  usePartEditorStore.setState({
    features,
    visibleFeatures: new Set(features.map(f => f.id)),
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

export function setupRollbackStore(features: PartFeature[], rollbackPosition: number | null) {
  seedFeatures(features)
  usePartEditorStore.setState({ rollbackPosition, editingFeatureId: null })
}

export function setupEditingStore(features: PartFeature[], editingFeatureId: string | null = null) {
  seedFeatures(features)
  usePartEditorStore.setState({ rollbackPosition: null, editingFeatureId })
}

export function createDragEvent(type: string, overrides: Record<string, unknown> = {}) {
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
export function grabRollback(bar: Element) {
  fireEvent(bar, new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
}

export function movePointer(clientY: number) {
  fireEvent(window, new MouseEvent('pointermove', { clientY }))
}

export function releasePointer(clientY: number) {
  fireEvent(window, new MouseEvent('pointerup', { clientY }))
}

// jsdom reports a zero rect for everything, but the drop-slot maths needs real
// rows: lay the feature items out as a 40px stack starting at y = 0.
export function layoutFeatureRows() {
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
