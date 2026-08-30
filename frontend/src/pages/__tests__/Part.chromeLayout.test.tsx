// Where the editor chrome lives after the footer was removed: the copyright
// note became a logo tooltip, the debug toggles moved into the header's
// right-hand slot, and the measurement readout moved inside the viewport.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { type ReactNode } from 'react'
import Part from '@/pages/Part'
import { Wrapper } from '@/__tests__/test-utils'

vi.mock('../../hooks/usePartDoc', async () =>
  (await import('@/__tests__/test-utils')).partDocMockModule())

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule())

vi.mock('../../components/Toolbar/SketchToolbar', () => ({ default: () => null }))
vi.mock('../../components/layout/AppHeader', () => ({
  default: ({ children, rightContent }: { children: ReactNode; rightContent?: ReactNode }) =>
    <div data-testid="header">{children}{rightContent}</div>,
}))
vi.mock('../../components/layout/MeasurementDisplay', () => ({
  default: () => <div data-testid="measurement-readout" />,
}))
vi.mock('../../components/dialogs/ExportDialog', () => ({ default: () => null }))
vi.mock('../../components/dialogs/LoadingOverlay', () => ({ default: () => null }))
vi.mock('../../components/dialogs/RightClickMenu', async () =>
  (await import('@/__tests__/test-utils')).rightClickMenuMockModule())
vi.mock('../../components/layout/Sidebar', async () =>
  (await import('@/__tests__/test-utils')).sidebarMockModule())

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/documents/doc-1']}>
      <Routes>
        <Route path="/documents/:uuid" element={<Part />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: Wrapper },
  )
}

describe('Part editor chrome', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => cleanup())

  it('renders no footer bar at all', () => {
    renderPage()
    expect(document.querySelector('.doc-footer')).toBeNull()
    expect(screen.queryByText(/Copyright/)).toBeNull()
  })

  it('puts the collision-render toggle in the header, beside Report a bug', () => {
    renderPage()
    const button = screen.getByTitle('Show debug collision rendering')
    expect(screen.getByTestId('header').contains(button)).toBe(true)
  })

  it('puts the measurement readout inside the viewport HUD', () => {
    renderPage()
    const readout = screen.getByTestId('measurement-readout')
    expect(screen.getByTestId('viewport-hud').contains(readout)).toBe(true)
  })
})
