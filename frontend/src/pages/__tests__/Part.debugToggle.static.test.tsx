// The F2 debug toggle against the static build: debugToolsUnrestricted hands
// the panel to everyone, so a signed-out (non-admin) user must be able to
// drive the footer's visible debug button from the keyboard. Regression: the
// handler used to gate on is_admin alone, so on this build the button showed
// but its own shortcut key was dead. The http-build counterpart lives in
// Part.debugToggle.http.test.tsx (one capabilities mock per file).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { type ReactNode } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import Part from '@/pages/Part'
import { Wrapper } from '@/__tests__/test-utils'

vi.mock('@/config/capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/capabilities')>()),
  backend: 'static' as const,
  hasBackend: false,
  debugToolsUnrestricted: true,
}))

const authState: { user: Record<string, unknown> | null } = { user: null }
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => authState,
}))

vi.mock('../../hooks/usePartDoc', async () =>
  (await import('@/__tests__/test-utils')).partDocMockModule())

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule())

vi.mock('../../components/Toolbar/SketchToolbar', () => ({ default: () => null }))
vi.mock('../../components/layout/AppHeader', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
vi.mock('../../components/layout/FooterMeasurementDisplay', () => ({ default: () => null }))
vi.mock('../../components/dialogs/ExportDialog', () => ({ default: () => null }))
vi.mock('../../components/dialogs/ShareDialog', () => ({ default: () => null }))
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

function pressF2() {
  const event = new KeyboardEvent('keydown', { key: 'F2', code: 'F2', bubbles: true, cancelable: true })
  const prevented = vi.spyOn(event, 'preventDefault')
  act(() => { window.dispatchEvent(event) })
  return prevented
}

// Scoped by title: the footer also holds an unconditional collision-render
// button with the same class, and only this one reflects debugOpen.
const footerButton = () => document.querySelector('button[title="Toggle debug panel (F2)"]')

describe('Part F2 debug toggle (static build)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSketchEditorStore.setState({
      normalSelection: new Set(),
      hoveredSelectionId: null,
      hoveredVertexId: null,
      activeTool: null,
      activePickField: null, modeStack: [],
      showDebugHit: false,
    })
  })

  afterEach(() => {
    cleanup()
    authState.user = null
  })

  it('a non-admin toggles the debug panel and consumes the key', () => {
    authState.user = { id: 1, username: 'dev', must_change_password: false, is_admin: false }
    renderPage()

    const button = footerButton()
    expect(button).toBeTruthy()
    expect(pressF2()).toHaveBeenCalled()

    expect(button!.classList.contains('active')).toBe(true)
    expect(pressF2()).toHaveBeenCalled()
    expect(button!.classList.contains('active')).toBe(false)
  })
})
