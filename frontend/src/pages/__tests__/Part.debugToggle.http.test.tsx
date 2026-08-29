// The F2 debug toggle against the server build: the capability is closed
// (debugToolsUnrestricted false), so the panel is admin-only AND an unhandled
// F2 must fall through untouched instead of being swallowed with a
// preventDefault. The static-build counterpart lives in
// Part.debugToggle.static.test.tsx (one capabilities mock per file).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { type ReactNode } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import Part from '@/pages/Part'
import { Wrapper } from '@/__tests__/test-utils'

vi.mock('@/config/capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/capabilities')>()),
  backend: 'http' as const,
  hasBackend: true,
  debugToolsUnrestricted: false,
}))

// Mutable holder so each test can pick the signed-in user's privilege.
const authState: { user: Record<string, unknown> | null } = { user: null }
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => authState,
}))

vi.mock('../../hooks/usePartDoc', async () =>
  (await import('@/__tests__/test-utils')).partDocMockModule())

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule())

vi.mock('../../components/Toolbar/SketchToolbar', () => ({ default: () => null }))
vi.mock('../../components/layout/AppHeader', () => ({
  default: ({ children, rightContent }: { children: ReactNode; rightContent?: ReactNode }) =>
    <div>{children}{rightContent}</div>,
}))
vi.mock('../../components/layout/MeasurementDisplay', () => ({ default: () => null }))
vi.mock('../../components/dialogs/ExportDialog', () => ({ default: () => null }))
vi.mock('../../components/dialogs/ShareDialog', () => ({ default: () => null }))
vi.mock('../../components/dialogs/LoadingOverlay', () => ({ default: () => null }))
vi.mock('../../components/dialogs/RightClickMenu', async () =>
  (await import('@/__tests__/test-utils')).rightClickMenuMockModule())
vi.mock('../../components/layout/Sidebar', async () =>
  (await import('@/__tests__/test-utils')).sidebarMockModule())

const ADMIN = { id: 1, username: 'root', must_change_password: false, is_admin: true }
const NON_ADMIN = { id: 2, username: 'dev', must_change_password: false, is_admin: false }

function renderPage(withEditableTarget = false) {
  return render(
    <MemoryRouter initialEntries={['/documents/doc-1']}>
      <Routes>
        <Route path="/documents/:uuid" element={<Part />} />
      </Routes>
      {withEditableTarget && <input data-testid="field" />}
    </MemoryRouter>,
    { wrapper: Wrapper },
  )
}

// Returns the preventDefault spy so a test can tell a handled key (toggle +
// preventDefault) from an unhandled fall-through (neither). Dispatch runs
// inside act so the toggle's setState is flushed before assertions.
function pressF2(target?: Element) {
  const event = new KeyboardEvent('keydown', { key: 'F2', code: 'F2', bubbles: true, cancelable: true })
  const prevented = vi.spyOn(event, 'preventDefault')
  act(() => { (target ?? window).dispatchEvent(event) })
  return prevented
}

// Scoped by title: the header also holds an unconditional collision-render
// button with the same class, and only this one reflects debugOpen.
const headerButton = () => document.querySelector('button[title="Toggle debug panel (F2)"]')

describe('Part F2 debug toggle (http build)', () => {
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

  it('an admin toggles the debug panel and consumes the key', () => {
    authState.user = ADMIN
    renderPage()

    const button = headerButton()
    expect(button).toBeTruthy()
    expect(pressF2()).toHaveBeenCalled()

    expect(button!.classList.contains('active')).toBe(true)
    expect(pressF2()).toHaveBeenCalled()
    expect(button!.classList.contains('active')).toBe(false)
  })

  it('an admin toggles even when an editable field has focus', () => {
    authState.user = ADMIN
    renderPage(true)

    expect(pressF2(screen.getByTestId('field'))).toHaveBeenCalled()
    expect(headerButton()!.classList.contains('active')).toBe(true)
  })

  it('a non-admin gets the key passed through untouched', () => {
    authState.user = NON_ADMIN
    renderPage(true)

    // The debug-panel button stays hidden for a non-admin on this build, and
    // the keydown is left alone rather than eaten by a dead handler.
    expect(headerButton()).toBeNull()
    expect(pressF2(screen.getByTestId('field'))).not.toHaveBeenCalled()
    expect(headerButton()).toBeNull()
  })
})
