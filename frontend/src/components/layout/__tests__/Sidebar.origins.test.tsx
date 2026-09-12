import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Sidebar } from '@/components/layout/Sidebar'
import { useLayoutStore } from '@/stores/layoutStore'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'

// C6 adds a third activity-bar icon through the C4 registry. It switches like
// the others and the panels already mounted keep their place.

beforeEach(() => {
  useLayoutStore.setState({ activePanel: 'document', visited: [] })
  useWorkspaceSessionStore.setState({ session: null })
})

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar documentPanel={<div data-testid="doc-panel" />} />
    </MemoryRouter>,
  )
}

describe('Sidebar origins panel', () => {
  it('offers a third icon that switches to the origins panel', () => {
    const { container } = renderSidebar()
    const origins = screen.getByRole('button', { name: 'Origins' })
    expect(origins).toBeInTheDocument()
    // Lazy-mounted on first activation.
    expect(container.querySelector('.origins-panel')).toBeNull()

    fireEvent.click(origins)
    expect(container.querySelector('.origins-panel')).toBeTruthy()
    expect(screen.getByText('Nothing was imported from outside.')).toBeInTheDocument()
  })

  it('preserves the document panel across a switch to origins and back', () => {
    renderSidebar()
    const docPanel = screen.getByTestId('doc-panel')
    expect(docPanel.closest('.sidebar-panel')?.hasAttribute('hidden')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Origins' }))
    expect(docPanel.closest('.sidebar-panel')?.hasAttribute('hidden')).toBe(true)
    expect(docPanel.isConnected).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Document' }))
    expect(docPanel.closest('.sidebar-panel')?.hasAttribute('hidden')).toBe(false)
  })
})
