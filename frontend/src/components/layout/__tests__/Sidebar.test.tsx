import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Sidebar } from '@/components/layout/Sidebar'
import type { PartFeature } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { PartEditorProvider } from '@/contexts/PartEditorContext'

// J4: the editor has no workspace layer. The workspace tree, the files and
// origins panels and the rail that switched between them left with the
// redesign, so the sidebar hosts one thing and hosts it unconditionally --
// there is no activity bar to find and no hidden second panel behind it.

function makeCallbacks() {
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
  }
}

const features: PartFeature[] = [
  { id: 'Origin', kind: 'origin' },
  { id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: 10, direction: 'normal' } },
]

beforeEach(() => {
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
  useSketchEditorStore.setState({ normalSelection: new Set(), activePickField: null, modeStack: [] })
})

describe('Sidebar hosts the document navigator alone', () => {
  it('gives the part editor its feature stack and no workspace layer', () => {
    const { container } = render(
      <MemoryRouter>
        <PartEditorProvider value={makeCallbacks()}>
          <Sidebar />
        </PartEditorProvider>
      </MemoryRouter>,
    )
    const aside = container.querySelector('.doc-sidebar') as HTMLElement
    expect(aside.children).toHaveLength(1)
    expect(aside.children[0]).toHaveClass('document-panel')
    expect(screen.queryByRole('toolbar', { name: 'Panels' })).toBeNull()
    expect(container.querySelector('.workspace-tree')).toBeNull()
    expect(container.querySelector('.files-panel')).toBeNull()
    expect(container.querySelector('.origins-panel')).toBeNull()
  })

  it('gives the assembly editor its own navigator and nothing beside it', () => {
    const { container } = render(
      <MemoryRouter>
        <Sidebar documentPanel={<div data-testid="doc-panel" />} />
      </MemoryRouter>,
    )
    const aside = container.querySelector('.doc-sidebar') as HTMLElement
    expect(aside.children).toHaveLength(1)
    expect(screen.getByTestId('doc-panel')).toBeInTheDocument()
    // The navigator is never hidden: nothing can switch away from it.
    expect(screen.getByTestId('doc-panel').hasAttribute('hidden')).toBe(false)
    expect(screen.queryByRole('toolbar', { name: 'Panels' })).toBeNull()
    expect(container.querySelector('.workspace-tree')).toBeNull()
  })
})
