// The rollback bar and the two sidebar splits are pointer-only today: a
// keyboard-only user can neither set the rollback position nor resize either
// pane. They are exposed as sliders with arrow-key stepping so both are
// reachable without a mouse, while the pointer paths stay unchanged.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from '@/components/layout/Sidebar'
import { AssemblyTree } from '@/components/layout/AssemblyTree'
import type { PartFeature, PartInstance } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { PartEditorProvider } from '@/contexts/PartEditorContext'
import type { PartEditorCallbacks } from '@/contexts/PartEditorContext'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'

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

const extraFeatures: PartFeature[] = [
  { id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: 10, direction: 'normal' } },
  { id: 'sk1', kind: 'sketch' },
]

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
  useSketchEditorStore.setState({ normalSelection: new Set(), activePickField: null, modeStack: [] })
}

beforeEach(() => {
  setupStore([], null)
  usePartEditorStore.setState({ editingFeatureId: null })
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
    usePartEditorStore.setState({ editingFeatureId: 'ex1' })
    renderSidebar(makeCallbacks({ onSetRollbackPosition }))
    const bar = screen.getByTitle('Rollback')

    fireEvent.keyDown(bar, { key: 'ArrowUp' })
    expect(onSetRollbackPosition).not.toHaveBeenCalled()
  })
})

describe('sidebar split handle keyboard slider', () => {
  it('exposes the part splitter as a slider stepped by arrow keys', () => {
    setupStore([...builtInFeatures, ...extraFeatures], null)
    renderSidebar()
    const handle = screen.getByTitle('Drag to resize')
    expect(handle.getAttribute('role')).toBe('slider')
    expect(handle.getAttribute('tabindex')).toBe('0')
    const before = Number(handle.getAttribute('aria-valuenow'))

    fireEvent.keyDown(handle, { key: 'ArrowDown' })
    expect(Number(handle.getAttribute('aria-valuenow'))).toBeGreaterThan(before)
  })
})

const instances: PartInstance[] = [
  { handle: 'p1', doc_id: 'doc-p1', doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, visible: true },
]

const noop = () => {}

function renderAssemblyTree() {
  return render(
    <AssemblyTree
      instances={instances}
      builtins={[]}
      mates={[]}
      onOpenPartNewTab={noop}
      onDuplicateInstance={noop}
      onDeleteInstance={noop}
      onToggleVisible={noop}
      onToggleFixed={noop}
      onToggleBuiltinVisible={noop}
      onEditInstance={noop}
      onCommitInstance={noop}
      onCancelInstance={noop}
      renderInstanceEditor={() => null}
      onCommitMate={noop}
      onCancelMate={noop}
      onDeleteMate={noop}
      onRequestRenameMate={noop}
      renderMateEditor={() => null}
    />
  )
}

describe('assembly split handle keyboard slider', () => {
  it('exposes the assembly splitter as a slider stepped by arrow keys', () => {
    renderAssemblyTree()
    const handle = screen.getByTitle('Drag to resize')
    expect(handle.getAttribute('role')).toBe('slider')
    const before = Number(handle.getAttribute('aria-valuenow'))

    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(Number(handle.getAttribute('aria-valuenow'))).toBeLessThan(before)
  })
})
