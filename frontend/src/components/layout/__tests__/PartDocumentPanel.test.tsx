// The part editor's navigator is two floating cards. Phase 1 moved it out of
// the Sidebar aside and into the viewport overlay
// (pages/PartEditorPanel.tsx), and this pins the stack the overlay mounts: one
// .document-panel wrapper holding the Features card over the Parts card, with
// no workspace layer left anywhere in it.
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PartDocumentPanel } from '@/components/layout/PartDocumentPanel'
import { PartEditorProvider } from '@/contexts/PartEditorContext'

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

describe('PartDocumentPanel', () => {
  it('stacks its features and parts cards under the document-panel wrapper', () => {
    const { container } = render(
      <PartEditorProvider value={makeCallbacks()}>
        <PartDocumentPanel />
      </PartEditorProvider>,
    )
    const panel = container.querySelector('.document-panel') as HTMLElement
    expect(panel).not.toBeNull()
    expect(panel.children).toHaveLength(2)
    expect(panel.children[0]).toHaveClass('sidebar-top')
    expect(panel.children[1]).toHaveClass('sidebar-bottom')
    expect(screen.queryByRole('toolbar', { name: 'Panels' })).toBeNull()
    expect(container.querySelector('.workspace-tree')).toBeNull()
    expect(container.querySelector('.files-panel')).toBeNull()
    expect(container.querySelector('.origins-panel')).toBeNull()
  })
})
