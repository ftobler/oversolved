import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from '@/components/layout/Sidebar'
import { FeatureEditPanel } from '@/components/layout/FeatureEditPanel'
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

function renderSidebar(storeFeatures: PartFeature[], editingFeatureId: string | null, callbacks: Partial<PartEditorCallbacks> = {}) {
  useEditorState.setState({ editingFeatureId })
  usePartEditorStore.setState({
    features: storeFeatures,
    visibleFeatures: new Set(storeFeatures.map(f => f.id)),
    doc: null,
    visibleBodies: new Set(),
    partLabels: {},
    solveResults: {},
    bodies: {},
    isRebuilding: false,
    featureTimings: {},
  })
  useEditorState.setState({
    rollbackPosition: null,
  })
  useEditorState.setState({
    normalSelection: new Set(),
    activePickField: null,
    modeStack: [],
  })
  return render(
    <PartEditorProvider value={makeCallbacks(callbacks)}>
      <Sidebar />
      <FeatureEditPanel />
    </PartEditorProvider>
  )
}

beforeEach(() => {
  usePartEditorStore.setState({
    features: [],
    visibleFeatures: new Set(),
    doc: null,
    visibleBodies: new Set(),
    partLabels: {},
    solveResults: {},
    bodies: {},
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
})

const revolveFeature: PartFeature = {
  id: 'rev1',
  kind: 'revolve',
  revolve: { sketch: '$sk1', angle: 360 },
}

describe('merge target PickChip in RevolveEditor', () => {
  it('is shown for add operation (default)', () => {
    renderSidebar([revolveFeature], 'rev1')
    expect(screen.getByText('Merge Target')).toBeInTheDocument()
  })

  it('is shown for cut operation', () => {
    const cutFeature: PartFeature = {
      id: 'rev1', kind: 'revolve',
      revolve: { sketch: '$sk1', angle: 360, operation: 'cut' },
    }
    renderSidebar([cutFeature], 'rev1')
    expect(screen.getByText('Merge Target')).toBeInTheDocument()
  })

  it('is hidden for new operation', () => {
    const newFeature: PartFeature = {
      id: 'rev1', kind: 'revolve',
      revolve: { sketch: '$sk1', angle: 360, operation: 'new' },
    }
    renderSidebar([newFeature], 'rev1')
    expect(screen.queryByText('Merge Target')).toBeNull()
  })

  it('shows (all bodies) when no merge_target set', () => {
    renderSidebar([revolveFeature], 'rev1')
    expect(screen.getByText('(all bodies)')).toBeInTheDocument()
  })

  it('activates pick mode on chip click', () => {
    renderSidebar([revolveFeature], 'rev1')
    const chip = screen.getByText('(all bodies)').closest('.feature-pick-chip')!
    fireEvent.click(chip)
    expect(chip.classList.contains('picking')).toBe(true)
  })

  it('deactivates pick mode when chip clicked while already picking', () => {
    renderSidebar([revolveFeature], 'rev1')
    const chip = screen.getByText('(all bodies)').closest('.feature-pick-chip')!
    fireEvent.click(chip)
    expect(chip.classList.contains('picking')).toBe(true)
    fireEvent.click(chip)
    expect(chip.classList.contains('picking')).toBe(false)
  })
})
