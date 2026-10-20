// The phone-width navigator: Part.css hides the floating cards below the
// breakpoint so the model fills the screen, and the toolbar's one panels
// toggle brings them back as a drawer. jsdom applies no stylesheet, so the
// button's job is pinned here as the class the CSS keys on; the hide/show
// rules themselves are pinned in narrowChrome.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import PartEditorPanel from '@/pages/PartEditorPanel'

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule())
vi.mock('../../components/Toolbar/SketchToolbar', () => ({ default: () => null }))
vi.mock('../../components/dialogs/LoadingOverlay', () => ({ default: () => null }))

function renderPanel() {
  return render(
    <PartEditorPanel
      mode="feature"
      setMode={vi.fn()}
      solveError={null}
      setSolveError={vi.fn()}
      error={null}
      setError={vi.fn()}
      loading={false}
      planeSelectionFeatureId={null}
      handleAddFeature={vi.fn()}
      handleAddSketch={vi.fn()}
      handleAddPlane={vi.fn()}
      viewportRef={{ current: null }}
      handleRightClick={vi.fn()}
    />,
  )
}

describe('PartEditorPanel panels toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => cleanup())

  it('opens and closes the drawer through one button, reported on the container', () => {
    const { container } = renderPanel()
    const containerEl = container.querySelector('.doc-container') as HTMLElement
    const toggle = screen.getByRole('button', { name: 'Show panels' })
    expect(containerEl.classList.contains('panels-open')).toBe(false)

    fireEvent.click(toggle)
    expect(containerEl.classList.contains('panels-open')).toBe(true)
    expect(screen.getByRole('button', { name: 'Hide panels' })).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Hide panels' }))
    expect(containerEl.classList.contains('panels-open')).toBe(false)
    expect(screen.getByRole('button', { name: 'Show panels' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('offers exactly one panels control, not one per panel', () => {
    renderPanel()
    expect(screen.getAllByRole('button', { name: /panels/i })).toHaveLength(1)
  })

  // The file actions moved to the header's document group. Leaving them in the
  // feature toolbar would give the part two import buttons and two exports.
  it('no longer carries the STEP import or the export', () => {
    renderPanel()
    expect(screen.queryByTitle('Import STEP')).toBeNull()
    expect(screen.queryByTitle('Export')).toBeNull()
  })
})
