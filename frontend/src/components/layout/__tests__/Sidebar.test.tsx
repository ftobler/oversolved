// J4: the editor has no workspace layer. The workspace tree, the files and
// origins panels and the rail that switched between them left with the
// redesign, so the aside hosts one navigator and nothing else -- no activity
// bar to find and no hidden second panel behind it. Phase 1 left this host to
// the assembly editor (its only production caller): the part navigator is
// PartDocumentPanel, mounted directly in the viewport overlay, and its own
// stack is pinned in PartDocumentPanel.test.tsx.
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Sidebar } from '@/components/layout/Sidebar'

describe('Sidebar hosts the document navigator alone', () => {
  it('renders exactly the navigator it is handed, with no workspace layer', () => {
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
