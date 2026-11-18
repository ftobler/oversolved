// The rollback bar is pointer-only today: a keyboard-only user cannot set the
// rollback position. It is exposed as a slider with arrow-key stepping so it is
// reachable without a mouse, while the pointer path stays unchanged. The
// assembly splitter this file once covered went with the floating panels: both
// editors size their cards to the shared 64/36 panel split and no longer resize
// one column.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PartDocumentPanel } from '@/components/layout/PartDocumentPanel'
import type { PartFeature } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'

import { PartEditorProvider } from '@/contexts/PartEditorContext'
import type { PartEditorCallbacks } from '@/contexts/PartEditorContext'
import { useEditorState } from '@/hooks/useEditorState'

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
      <PartDocumentPanel />
    </PartEditorProvider>
  )
}

const builtInFeatures: PartFeature[] = [
  { id: 'Origin', kind: 'origin' },
  { id: 'Top', kind: 'plane' },
  { id: 'Front', kind: 'plane' },
  { id: 'Right', kind: 'plane' },
]

const extraFeatures: PartFeature[] = [
  { id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: 10, direction: 'normal' } },
  { id: 'sk1', kind: 'sketch' },
]

function setupStore(features: PartFeature[], rollbackPosition: number | null) {
  useEditorState.setState({ rollbackPosition, editingFeatureId: null })
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
    editingFeatureId: null,
  })
  useEditorState.setState({
    normalSelection: new Set(),
    activePickField: null,
    modeStack: [],
  })
}

beforeEach(() => {
  setupStore([], null)
  useEditorState.setState({
    editingFeatureId: null,
  })
})

describe('rollback bar keyboard slider', () => {
  it('exposes the bar as a slider carrying the rollback value and limits', () => {
    setupStore([...builtInFeatures, ...extraFeatures], 5)
    renderSidebar()
    const bar = screen.getByTitle('Rollback')
    expect(bar.getAttribute('role')).toBe('slider')
    expect(bar.getAttribute('tabindex')).toBe('0')
    expect(bar.getAttribute('aria-valuenow')).toBe('5')
    expect(bar.getAttribute('aria-valuemin')).toBe('4')
    expect(bar.getAttribute('aria-valuemax')).toBe('6')
  })

  it('steps the rollback position up and down with the arrow keys', () => {
    const onSetRollbackPosition = vi.fn()
    setupStore([...builtInFeatures, ...extraFeatures], 5)
    renderSidebar(makeCallbacks({ onSetRollbackPosition }))
    const bar = screen.getByTitle('Rollback')

    fireEvent.keyDown(bar, { key: 'ArrowUp' })
    expect(onSetRollbackPosition).toHaveBeenCalledWith(4)

    fireEvent.keyDown(bar, { key: 'ArrowDown' })
    expect(onSetRollbackPosition).toHaveBeenCalledWith(6)
  })

  it('clamps the step past the built-ins without committing a no-op', () => {
    const onSetRollbackPosition = vi.fn()
    setupStore([...builtInFeatures, ...extraFeatures], 4)
    renderSidebar(makeCallbacks({ onSetRollbackPosition }))
    const bar = screen.getByTitle('Rollback')

    fireEvent.keyDown(bar, { key: 'ArrowUp' })
    expect(onSetRollbackPosition).not.toHaveBeenCalled()
  })

  it('does not step while a feature edit pins the rollback', () => {
    const onSetRollbackPosition = vi.fn()
    setupStore([...builtInFeatures, ...extraFeatures], 5)
    useEditorState.setState({
    editingFeatureId: 'ex1',
  })
    renderSidebar(makeCallbacks({ onSetRollbackPosition }))
    const bar = screen.getByTitle('Rollback')

    fireEvent.keyDown(bar, { key: 'ArrowUp' })
    expect(onSetRollbackPosition).not.toHaveBeenCalled()
  })
})
