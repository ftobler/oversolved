// Shared harness for the part navigator layout tests: callbacks, render
// wrapper, store fixtures and the pointer/drag event helpers. renderSidebar
// keeps its historical name; it mounts PartDocumentPanel, the stack the part
// editor floats over the viewport, not the Sidebar aside.
import { vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { PartDocumentPanel } from '@/components/layout/PartDocumentPanel'
import type { PartFeature } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'

import { PartEditorProvider } from '@/contexts/PartEditorContext'
import type { PartEditorCallbacks } from '@/contexts/PartEditorContext'
import { useEditorState } from '@/hooks/useEditorState'
import { installPointerEventStub } from '@/testing/pointerEventStub'

// The row drag reads pointerType and pointerId, which jsdom's MouseEvent-only
// event set cannot carry, and takes a pointer capture the browser would give it.
installPointerEventStub('mouse')
const htmlProto = HTMLElement.prototype as unknown as Record<string, (pointerId: number) => unknown>
htmlProto.setPointerCapture = () => {}
htmlProto.releasePointerCapture = () => {}
htmlProto.hasPointerCapture = () => false

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
      <PartDocumentPanel />
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
    visibleFeatures: new Set(),
    doc: null,
    visibleParts: new Set(),
    partLabels: {},
    solveResults: {},
    parts: {},
    isRebuilding: false,
    featureTimings: {},
  })
  useEditorState.setState({
    rollbackPosition: null,
    editingFeatureId: null,
  })
  useEditorState.setState({
    normalSelection: new Set(),
    activePickField: null,
    modeStack: [],
  })
}

function seedFeatures(features: PartFeature[]) {
  usePartEditorStore.setState({
    features,
    visibleFeatures: new Set(features.map(f => f.id)),
    doc: null,
    visibleParts: new Set(),
    partLabels: {},
    solveResults: {},
    parts: {},
    isRebuilding: false,
    featureTimings: {},
  })
  useEditorState.setState({
    normalSelection: new Set(),
    activePickField: null,
    modeStack: [],
  })
}

export function setupRollbackStore(features: PartFeature[], rollbackPosition: number | null) {
  seedFeatures(features)
  useEditorState.setState({ rollbackPosition, editingFeatureId: null })
}

export function setupEditingStore(features: PartFeature[], editingFeatureId: string | null = null) {
  seedFeatures(features)
  useEditorState.setState({ rollbackPosition: null, editingFeatureId })
}

// A feature row drags on raw pointer events now, the same as the bar. Press the
// row, move the pointer over the list, release it anywhere on the page. The
// pointer id models one finger: a second id is a different pointer.
export function pressRow(
  el: Element,
  init: { clientX?: number; clientY?: number; pointerId?: number; pointerType?: string } = {},
) {
  fireEvent.pointerDown(el, {
    bubbles: true,
    cancelable: true,
    button: 0,
    isPrimary: true,
    pointerId: 0,
    ...init,
  })
}

// The rollback bar rides on raw pointer events (native HTML5 drag drops the
// release when a rebuild stalls the main thread), so drive it the way a browser
// would: press the bar, move the pointer, release it anywhere on the page.
export function grabRollback(bar: Element) {
  fireEvent(bar, new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
}

export function movePointer(clientY: number, clientX = 0, pointerId = 0) {
  fireEvent.pointerMove(window, { clientY, clientX, pointerId })
}

export function releasePointer(clientY: number, clientX = 0, pointerId = 0) {
  fireEvent.pointerUp(window, { clientY, clientX, pointerId })
}

// The browser drops pointer capture when the mouse is released outside the
// window; the element that held it gets nothing else to commit with.
export function losePointerCapture(el: Element, pointerId = 0) {
  fireEvent(el, new PointerEvent('lostpointercapture', { bubbles: true, pointerId }))
}

export interface RowLayout {
  gap?: number
  rowHeight?: number
  // Empty space below the last row: the list is the flexible card body, so this
  // is still inside it.
  tail?: number
  // Slot the rollback bar is drawn in. Rows from here down are pushed past the
  // bar's band, like the real li in the list flow.
  barIndex?: number
  barBand?: number
}

// jsdom reports a zero rect for everything, but the drop-slot maths needs real
// rows: lay the feature items out as a stack starting at y = 0. The list itself
// gets the full body height so the bounds and the auto-scroll edges have a real
// card to measure.
export function layoutFeatureRows({
  gap = 0, rowHeight = 40, tail = 120, barIndex = -1, barBand = 0,
}: RowLayout = {}) {
  const rows = document.querySelectorAll('.feature-item')
  rows.forEach((el, i) => {
    const top = i * (rowHeight + gap) + (barIndex >= 0 && i >= barIndex ? barBand : 0)
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      top,
      bottom: top + rowHeight,
      height: rowHeight,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: top,
      toJSON: () => {},
    })
  })
  const bar = document.querySelector('.rollback-bar')
  if (bar && barIndex >= 0) {
    const top = barIndex * (rowHeight + gap)
    vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue({
      top,
      bottom: top + barBand,
      height: barBand,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: top,
      toJSON: () => {},
    })
  }
  const list = document.querySelector('.features-list')
  if (list) {
    const bottom = rows.length * (rowHeight + gap) - gap
      + (barIndex >= 0 ? barBand : 0) + tail
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom,
      height: bottom,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: 0,
      toJSON: () => {},
    })
  }
}
