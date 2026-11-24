// Where the editor chrome lives after the footer was removed: the copyright
// note became a logo tooltip, the debug toggles moved into the header's
// right-hand slot, and the measurement readout moved into the viewport's
// bottom-left slot. With floating panels (phase 1) the part navigator and the
// open feature editor are overlay cards inside the viewport stage as well, not
// sidebar columns.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { type ReactNode } from 'react'
import Part from '@/pages/Part'
import { backendBundle } from '@/adapters/backend'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useBugReportStore } from '@/stores/bugReportStore'
import { DEFAULT_SECTION_STATE, useSectionStore } from '@/stores/sectionStore'
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

const INCH_EXTRUDE_DOC = `version: 1
kind: part
length_unit: inch
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

/** Turn the section on and let the card's mount settle before asserting. */
async function enableSection() {
  await act(async () => { useSectionStore.setState({ enabled: true }) })
}

describe('Part editor chrome', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    partDocStoreMock()
    useSectionStore.setState({ ...DEFAULT_SECTION_STATE })
  })
  afterEach(() => {
    act(() => {
      useBugReportStore.getState().discard()
      useSectionStore.setState({ ...DEFAULT_SECTION_STATE })
    })
    cleanup()
  })

  it('renders no footer bar at all', async () => {
    await renderPageLoaded()
    expect(document.querySelector('.doc-footer')).toBeNull()
    expect(screen.queryByText(/Copyright/)).toBeNull()
  })

  it('no longer puts the collision-render toggle in the header', async () => {
    await renderPageLoaded()
    expect(screen.queryByTitle('Show debug collision rendering')).toBeNull()
    // The header keeps the F2 debug panel, which is a different thing.
    expect(screen.getByTitle('Toggle debug panel (F2)')).toBeInTheDocument()
  })

  it('puts the measurement readout in its own bottom-left slot, not the HUD', async () => {
    await renderPageLoaded()
    const readout = screen.getByTestId('measurement-readout')
    expect(screen.getByTestId('viewport-readout').contains(readout)).toBe(true)
    expect(screen.getByTestId('viewport-hud').contains(readout)).toBe(false)
  })

  it('hands the view options button to the HUD slot above the cube', async () => {
    await renderPageLoaded()
    const slot = screen.getByTestId('viewport-hud-view-options')
    expect(slot.querySelector('button[aria-label="View options"]')).not.toBeNull()
    // The stack order is options then cube; the readout left this column for
    // its own bottom-left slot, so the option slot is the column's first child.
    const hud = screen.getByTestId('viewport-hud')
    expect(hud.firstElementChild).toBe(slot)
  })

  it('hides the unit row until the document has loaded', () => {
    // Hold the load open: the first frame must not show a unit the page does
    // not own yet, because the row would dispatch into an absent document.
    vi.spyOn(backendBundle.documents, 'load').mockReturnValue(new Promise<never>(() => {}))
    renderPage()
    expect(usePartEditorStore.getState().doc).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    expect(screen.getByRole('menu', { name: 'View options' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Length unit' })).toBeNull()
    // The browser-local rows still render while the document loads.
    expect(screen.getByRole('menuitemcheckbox', { name: 'Shading' })).toBeInTheDocument()
  })

  it('switches the document unit from the view options as one undo entry', async () => {    await renderPageLoaded()
    fireEvent.click(screen.getByRole('button', { name: 'View options' }))

    expect(screen.getByRole('button', { name: 'millimetres' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'inches' })).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'inches' }))
    await waitFor(() => expect(usePartEditorStore.getState().doc?.length_unit).toBe('inch'))
    expect(usePartEditorStore.getState().undoStack).toHaveLength(1)

    // The row now reads the new unit, and asking for it again is not a second
    // history step.
    expect(screen.getByRole('button', { name: 'inches' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'inches' }))
    expect(usePartEditorStore.getState().undoStack).toHaveLength(1)
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
    await waitFor(() => expect(screen.getByText("extrude 'Extrude 1'")).toBeInTheDocument())
    expect(document.querySelector('.feature-edit-panel')).toBeNull()

    fireEvent.click(screen.getByTitle('Edit extrude'))

    const stage = document.querySelector('.viewport-stage')!
    const panel = document.querySelector('.feature-edit-panel')!
    expect(panel).not.toBeNull()
    expect(stage.contains(panel)).toBe(true)

    // OK in the row closes the panel too: the edit can be ended where it began.
    const row = within(document.querySelector('.feature-item.editing') as HTMLElement)
    fireEvent.click(row.getByTitle('OK'))
    await waitFor(() => expect(document.querySelector('.feature-edit-panel')).toBeNull())
  })

  it('closes the feature editor card on Cancel too', async () => {
    partDocStoreMock({ content: EXTRUDE_DOC })
    renderPage()
    await waitFor(() => expect(screen.getByText("extrude 'Extrude 1'")).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('Edit extrude'))
    expect(document.querySelector('.feature-edit-panel')).not.toBeNull()

    const row = within(document.querySelector('.feature-item.editing') as HTMLElement)
    fireEvent.click(row.getByTitle('Cancel'))
    await waitFor(() => expect(document.querySelector('.feature-edit-panel')).toBeNull())
  })

  it('stacks the bug report beside the feature editor in the right overlay', async () => {
    await renderPageLoaded()
    act(() => { useBugReportStore.getState().openReport([]) })

    const panel = document.querySelector('.bug-report-panel')!
    expect(panel).not.toBeNull()
    const stage = document.querySelector('.viewport-stage')!
    expect(stage.contains(panel)).toBe(true)
    expect(document.querySelector('.right-overlay-stack')!.contains(panel)).toBe(true)
  })

  it('stacks the section card beside the feature editor as its own card', async () => {
    partDocStoreMock({ content: EXTRUDE_DOC })
    renderPage()
    await waitFor(() => expect(screen.getByText("extrude 'Extrude 1'")).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('Edit extrude'))
    await enableSection()

    const cards = document.querySelectorAll('.right-overlay-stack > .feature-edit-panel')
    expect(cards).toHaveLength(2)
    const section = document.querySelector('.section-panel')!
    expect(section).not.toBeNull()
    expect(screen.getByText('Section')).toBeInTheDocument()
    expect(document.querySelector('.right-overlay-stack')!.contains(section)).toBe(true)
  })

  it('exiting the section leaves the feature editor open and unchanged', async () => {
    partDocStoreMock({ content: EXTRUDE_DOC })
    renderPage()
    await waitFor(() => expect(screen.getByText("extrude 'Extrude 1'")).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('Edit extrude'))
    await enableSection()

    fireEvent.click(screen.getByRole('button', { name: 'Exit section view' }))

    expect(useSectionStore.getState().enabled).toBe(false)
    expect(document.querySelector('.section-panel')).toBeNull()
    const featureCard = document.querySelector('.right-overlay-stack .feature-edit-panel:not(.section-panel)')!
    expect(featureCard).not.toBeNull()
    expect(featureCard.textContent).toContain('Extrude 1')
  })

  it('ending the feature edit leaves the section on', async () => {
    partDocStoreMock({ content: EXTRUDE_DOC })
    renderPage()
    await waitFor(() => expect(screen.getByText("extrude 'Extrude 1'")).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('Edit extrude'))
    await enableSection()

    const featureCard = document.querySelector<HTMLElement>('.right-overlay-stack .feature-edit-panel:not(.section-panel)')!
    fireEvent.click(within(featureCard).getByTitle('Cancel'))

    await waitFor(() => expect(document.querySelector('.section-panel')).not.toBeNull())
    expect(useSectionStore.getState().enabled).toBe(true)
    expect(document.querySelectorAll('.right-overlay-stack > .feature-edit-panel')).toHaveLength(1)
  })

  it('section controls change no document and record no undo entry', async () => {
    const store = partDocStoreMock({ content: EXTRUDE_DOC })
    renderPage()
    await waitFor(() => expect(screen.getByText("extrude 'Extrude 1'")).toBeInTheDocument())
    await enableSection()

    const docBefore = usePartEditorStore.getState().doc
    const historyBefore = usePartEditorStore.getState().undoStack.length

    fireEvent.click(screen.getByRole('button', { name: 'Top' }))
    const offset = screen.getByRole('textbox', { name: /Section offset/ })
    fireEvent.focus(offset)
    fireEvent.change(offset, { target: { value: '12.5' } })
    fireEvent.blur(offset)
    fireEvent.click(screen.getByLabelText('Reverse direction'))

    expect(useSectionStore.getState().plane).toEqual({ kind: 'builtin', id: 'top' })
    expect(useSectionStore.getState().offset).toBe(12.5)
    expect(useSectionStore.getState().flipped).toBe(true)
    // The section is viewer state: the document object and the undo history
    // are untouched, and nothing asked the store to save.
    expect(usePartEditorStore.getState().doc).toBe(docBefore)
    expect(usePartEditorStore.getState().undoStack).toHaveLength(historyBefore)
    expect(store.save).not.toHaveBeenCalled()
  })

  it('accepts the offset in millimetres in a millimetre document', async () => {
    partDocStoreMock({ content: EXTRUDE_DOC })
    renderPage()
    await waitFor(() => expect(usePartEditorStore.getState().doc).not.toBeNull())
    await enableSection()

    const offset = screen.getByRole('textbox', { name: 'Section offset, millimetres' })
    fireEvent.focus(offset)
    fireEvent.change(offset, { target: { value: '1' } })
    fireEvent.blur(offset)

    expect(useSectionStore.getState().offset).toBe(1)
    expect(screen.getByText('mm')).toBeInTheDocument()
  })

  it('accepts the offset in the document unit', async () => {
    partDocStoreMock({ content: INCH_EXTRUDE_DOC })
    renderPage()
    await waitFor(() => expect(usePartEditorStore.getState().doc?.length_unit).toBe('inch'))
    await enableSection()

    const offset = screen.getByRole('textbox', { name: 'Section offset, inches' })
    fireEvent.focus(offset)
    fireEvent.change(offset, { target: { value: '1' } })
    fireEvent.blur(offset)

    // World units are the part's own units, so one typed inch is offset 1.
    expect(useSectionStore.getState().offset).toBe(1)
    expect(screen.getByText('in')).toBeInTheDocument()
  })
})
