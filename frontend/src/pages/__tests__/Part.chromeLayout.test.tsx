// Where the editor chrome lives after the footer was removed: the copyright
// note became a logo tooltip, the debug toggles moved into the header's
// right-hand slot, and the measurement readout moved inside the viewport. With
// floating panels (phase 1) the part navigator and the open feature editor are
// overlay cards inside the viewport stage as well, not sidebar columns.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { type ReactNode } from 'react'
import Part from '@/pages/Part'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'

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

const EXTRUDE_DOC = `version: 1
kind: part
features:
  - id: ex1
    kind: extrude
    label: Extrude 1
    extrude: { sketch: '$sk1', distance: 10, direction: 'normal' }
`

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

/** Renders the page and settles the async document load, so a chrome
 *  assertion is made against the loaded editor, not the boot frame. */
async function renderPageLoaded() {
  renderPage()
  await waitFor(() => expect(usePartEditorStore.getState().doc).not.toBeNull())
}

describe('Part editor chrome', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    partDocStoreMock()
  })
  afterEach(() => cleanup())

  it('renders no footer bar at all', async () => {
    await renderPageLoaded()
    expect(document.querySelector('.doc-footer')).toBeNull()
    expect(screen.queryByText(/Copyright/)).toBeNull()
  })

  it('puts the collision-render toggle in the header, beside Report a bug', async () => {
    await renderPageLoaded()
    const button = screen.getByTitle('Show debug collision rendering')
    expect(screen.getByTestId('header').contains(button)).toBe(true)
  })

  it('puts the measurement readout inside the viewport HUD', async () => {
    await renderPageLoaded()
    const readout = screen.getByTestId('measurement-readout')
    expect(screen.getByTestId('viewport-hud').contains(readout)).toBe(true)
  })

  it('floats the feature and parts lists inside the viewport stage', async () => {
    await renderPageLoaded()
    const stage = document.querySelector('.viewport-stage')!
    expect(stage).not.toBeNull()
    expect(stage.querySelector('.features-list')).not.toBeNull()
    expect(stage.querySelector('.parts-list')).not.toBeNull()
    // The navigator is not an opaque column beside the editor any more.
    expect(document.querySelector('.doc-sidebar')).toBeNull()
  })

  it('opens the feature editor as an overlay card in the stage and closes it on commit', async () => {
    partDocStoreMock({ content: EXTRUDE_DOC })
    renderPage()
    await waitFor(() => expect(screen.getByText('Extrude 1')).toBeInTheDocument())
    expect(document.querySelector('.feature-edit-panel')).toBeNull()

    fireEvent.click(screen.getByTitle('Edit extrude'))

    const stage = document.querySelector('.viewport-stage')!
    const panel = document.querySelector('.feature-edit-panel')!
    expect(panel).not.toBeNull()
    expect(stage.contains(panel)).toBe(true)

    fireEvent.click(screen.getByTitle('OK'))
    await waitFor(() => expect(document.querySelector('.feature-edit-panel')).toBeNull())
  })

  it('closes the feature editor card on Cancel too', async () => {
    partDocStoreMock({ content: EXTRUDE_DOC })
    renderPage()
    await waitFor(() => expect(screen.getByText('Extrude 1')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('Edit extrude'))
    expect(document.querySelector('.feature-edit-panel')).not.toBeNull()

    fireEvent.click(screen.getByTitle('Cancel'))
    await waitFor(() => expect(document.querySelector('.feature-edit-panel')).toBeNull())
  })
})
