import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Sidebar } from '@/components/layout/Sidebar'
import { AssemblyTree } from '@/components/layout/AssemblyTree'
import type { PartFeature, PartInstance } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { PartEditorProvider } from '@/contexts/PartEditorContext'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'

// Panel switching must not lose the open document navigator's DOM state: both
// panels stay mounted and toggle `hidden`, so scrollTop and selection survive.

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

const instances: PartInstance[] = [
  { handle: 'p1', doc_id: 'doc-p1', doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, visible: true },
]

const noop = () => {}

function renderAssemblySidebar() {
  return render(
    <MemoryRouter>
      <Sidebar
        documentPanel={
          <AssemblyTree
            instances={instances}
            builtins={[]}
            mates={[]}
            subject={{ kind: 'part', handle: 'p1' }}
            onOpenPartNewTab={noop}
            onDuplicateInstance={noop}
            onDeleteInstance={noop}
            onToggleVisible={noop}
            onToggleFixed={noop}
            onToggleBuiltinVisible={noop}
            onEditInstance={noop}
            onCommitInstance={noop}
            onCancelInstance={noop}
            renderInstanceEditor={() => <input />}
            onCommitMate={noop}
            onCancelMate={noop}
            onDeleteMate={noop}
            onRequestRenameMate={noop}
            renderMateEditor={() => null}
          />
        }
      />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  useLayoutStore.setState({ activePanel: 'document', visited: [] })
  useWorkspaceSessionStore.setState({ session: null })
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
  useSketchEditorStore.setState({ normalSelection: new Set(['@ex1']), activePickField: null, modeStack: [] })
})

describe('Sidebar panel switch keeps the part navigator', () => {
  it('preserves scrollTop and selection across Workspace then Document', () => {
    const { container } = render(
      <MemoryRouter>
        <PartEditorProvider value={makeCallbacks()}>
          <Sidebar />
        </PartEditorProvider>
      </MemoryRouter>,
    )
    const list = container.querySelector('.features-list') as HTMLElement
    expect(list).toBeTruthy()
    list.scrollTop = 123
    expect(container.querySelector('.feature-item.selected')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))
    fireEvent.click(screen.getByRole('button', { name: 'Document' }))

    expect(list.isConnected).toBe(true)
    expect(list.scrollTop).toBe(123)
    expect(container.querySelector('.feature-item.selected')).toBeTruthy()
  })
})

describe('Sidebar panel switch keeps the workspace navigator', () => {
  it('preserves the workspace list scroll position across a switch', () => {
    const { container } = render(
      <MemoryRouter>
        <PartEditorProvider value={makeCallbacks()}>
          <Sidebar />
        </PartEditorProvider>
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))
    const scroll = container.querySelector('.workspace-tree-scroll') as HTMLElement
    expect(scroll).toBeTruthy()
    scroll.scrollTop = 321

    fireEvent.click(screen.getByRole('button', { name: 'Document' }))
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))

    expect(scroll.isConnected).toBe(true)
    expect(scroll.scrollTop).toBe(321)
  })
})

describe('Sidebar panel switch keeps the part splitter', () => {
  it('preserves the split percentage across a switch', () => {
    const { container } = render(
      <MemoryRouter>
        <PartEditorProvider value={makeCallbacks()}>
          <Sidebar />
        </PartEditorProvider>
      </MemoryRouter>,
    )
    // jsdom rects are all zero, so the panel is given a height for the drag to
    // resolve against; 300px of 1000px is 30%, inside the clamp.
    const panel = container.querySelector('.document-panel') as HTMLElement
    panel.getBoundingClientRect = () => ({
      top: 0, height: 1000, left: 0, right: 0, bottom: 1000, width: 0, x: 0, y: 0,
      toJSON: () => ({}),
    })
    fireEvent.mouseDown(container.querySelector('.resize-handle') as HTMLElement)
    fireEvent.mouseMove(document, { clientY: 300 })
    const top = container.querySelector('.sidebar-top') as HTMLElement
    expect(top.style.height).toBe('30%')

    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))
    fireEvent.click(screen.getByRole('button', { name: 'Document' }))

    expect(top.isConnected).toBe(true)
    expect(top.style.height).toBe('30%')
  })
})

describe('Sidebar panel switch keeps the assembly navigator', () => {
  it('preserves both bands scrollTop and the selected subject', () => {
    const { container } = renderAssemblySidebar()
    const lists = [...container.querySelectorAll('.features-list')] as HTMLElement[]
    expect(lists).toHaveLength(2)
    lists[0].scrollTop = 77
    lists[1].scrollTop = 55
    expect(container.querySelector('.feature-item.selected')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))
    fireEvent.click(screen.getByRole('button', { name: 'Document' }))

    expect(lists[0].isConnected).toBe(true)
    expect(lists[1].isConnected).toBe(true)
    expect(lists[0].scrollTop).toBe(77)
    expect(lists[1].scrollTop).toBe(55)
    expect(container.querySelector('.feature-item.selected')).toBeTruthy()
  })
})
