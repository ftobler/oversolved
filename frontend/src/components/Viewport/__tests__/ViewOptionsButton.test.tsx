// The dropdown itself: what it opens, what closes it, and that its rows reach
// the store or the page's document commands. The placement (above the cube) and
// the bottom-sheet breakpoint are CSS, pinned in narrowChrome.test.ts, and the
// HUD slot is pinned through the page mock in Part.chromeLayout.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { backendBundle } from '@/adapters/backend'
import { DEFAULT_VIEW_PREFERENCES } from '@/adapters/preferences'
import ViewOptionsButton from '@/components/Viewport/ViewOptionsButton'
import type { ShowGroup, ShowGroupState } from '@/components/Viewport/viewOptionsShow'
import { useViewOptionsStore } from '@/stores/viewOptionsStore'
import { DEFAULT_SECTION_STATE, useSectionStore } from '@/stores/sectionStore'

const h = vi.hoisted(() => ({ notify: vi.fn() }))
vi.mock('@/contexts/ToastContext', () => ({ useNotifySafe: () => h.notify }))

const SHOW_STATES: Record<ShowGroup, ShowGroupState> = {
  planes: { visible: true, disabled: false },
  sketches: { visible: false, disabled: false },
  origin: { visible: true, disabled: true },
}

function reset(): void {
  useViewOptionsStore.setState({
    ...DEFAULT_VIEW_PREFERENCES,
    collisionDebug: false,
    shaderProbe: false,
    curvatureAutoRange: null,
  })
  useSectionStore.setState({ ...DEFAULT_SECTION_STATE })
}

function open(): void {
  fireEvent.click(screen.getByRole('button', { name: 'View options' }))
}

const row = (name: string) => screen.getByRole('menuitemcheckbox', { name })

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  h.notify.mockClear()
  reset()
})

describe('ViewOptionsButton open and close', () => {
  it('starts closed and the eye only opens the card', () => {
    render(<ViewOptionsButton />)
    expect(screen.getByRole('button', { name: 'View options' })).toBeInTheDocument()
    expect(screen.queryByRole('menu')).toBeNull()

    open()
    expect(screen.getByRole('menu', { name: 'View options' })).toBeInTheDocument()
    // Opening changed no viewer option: the eye is not a toggle.
    expect(useViewOptionsStore.getState().shading).toBe(true)
  })

  it('closes on a second eye click', () => {
    render(<ViewOptionsButton />)
    open()
    open()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closes on Escape and returns focus to the eye', () => {
    render(<ViewOptionsButton />)
    open()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'View options' }))
  })

  it('closes on an outside pointer but not on a row click', () => {
    render(<ViewOptionsButton />)
    open()
    fireEvent.click(row('Shading'))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps clicks inside the card away from the viewport beneath', () => {
    // The HUD column is click-through; a row that bubbled would land in the
    // canvas picking handlers as an empty-space click.
    const onPointerDown = vi.fn()
    const onClick = vi.fn()
    render(
      <div onPointerDown={onPointerDown} onClick={onClick}>
        <ViewOptionsButton />
      </div>,
    )
    open()
    fireEvent.pointerDown(row('Edges'))
    fireEvent.click(row('Edges'))

    expect(onPointerDown).not.toHaveBeenCalled()
    expect(onClick).not.toHaveBeenCalled()
    // The row itself still did its job.
    expect(useViewOptionsStore.getState().edges).toBe(false)
  })

  it('moves through the rows with the arrow keys', () => {
    render(<ViewOptionsButton />)
    open()
    const shading = row('Shading')
    shading.focus()
    fireEvent.keyDown(shading, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(row('Edges'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(row('Shading'))
  })
})

describe('ViewOptionsButton Show group', () => {
  it('reflects the group states and dispatches the group that was clicked', () => {
    const onToggleShow = vi.fn()
    render(<ViewOptionsButton show={SHOW_STATES} onToggleShow={onToggleShow} />)
    open()

    expect(row('Planes')).toHaveAttribute('aria-checked', 'true')
    expect(row('Sketches')).toHaveAttribute('aria-checked', 'false')
    expect(row('Origin')).toBeDisabled()

    fireEvent.click(row('Sketches'))
    expect(onToggleShow).toHaveBeenCalledWith('sketches')
  })

  it('has no Show group in the assembly', () => {
    render(<ViewOptionsButton />)
    open()
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Planes' })).toBeNull()
    expect(screen.queryByText('Show')).toBeNull()
    // The viewer rows are still there.
    expect(row('Shading')).toBeInTheDocument()
  })
})

describe('ViewOptionsButton viewer rows', () => {
  it('never lets the last drawn layer be turned off', () => {
    render(<ViewOptionsButton />)
    open()
    fireEvent.click(row('Edges'))
    expect(useViewOptionsStore.getState().edges).toBe(false)
    expect(row('Shading')).toBeDisabled()

    fireEvent.click(row('Shading'))
    expect(useViewOptionsStore.getState().shading).toBe(true)
    expect(row('Edges')).not.toBeDisabled()
  })

  it('sets, clamps and resets the brightness', () => {
    render(<ViewOptionsButton />)
    open()
    const slider = screen.getByRole('slider', { name: 'Brightness' })

    fireEvent.change(slider, { target: { value: '0' } })
    expect(useViewOptionsStore.getState().brightness).toBe(1)

    fireEvent.change(slider, { target: { value: '1' } })
    expect(useViewOptionsStore.getState().brightness).toBe(4)

    fireEvent.change(slider, { target: { value: '-1' } })
    expect(useViewOptionsStore.getState().brightness).toBe(0.25)

    fireEvent.doubleClick(slider)
    expect(useViewOptionsStore.getState().brightness).toBe(1)
  })

  it('persists a row and never persists the collision debug flag', () => {
    const save = vi.spyOn(backendBundle.preferences, 'save').mockResolvedValue(undefined)
    render(<ViewOptionsButton />)
    open()

    fireEvent.click(row('Edges'))
    expect(save).toHaveBeenCalled()

    save.mockClear()
    fireEvent.click(row('Collision render'))
    expect(useViewOptionsStore.getState().collisionDebug).toBe(true)
    expect(save).not.toHaveBeenCalled()
  })

  it('toggles the shader probe debug row without persisting it', () => {
    const save = vi.spyOn(backendBundle.preferences, 'save').mockResolvedValue(undefined)
    render(<ViewOptionsButton />)
    open()

    const probe = row('Shader probe')
    expect(probe).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(probe)
    expect(useViewOptionsStore.getState().shaderProbe).toBe(true)
    expect(probe).toHaveAttribute('aria-checked', 'true')
    expect(save).not.toHaveBeenCalled()
  })

  it('disables both analysis rows while shading is off', () => {
    useViewOptionsStore.setState({ shading: false, edges: true })
    render(<ViewOptionsButton />)
    open()
    expect(row('Zebra')).toBeDisabled()
    expect(row('Curvature')).toBeDisabled()
  })

  it('turns zebra and curvature mutually exclusive from the rows', () => {
    render(<ViewOptionsButton />)
    open()
    fireEvent.click(row('Zebra'))
    expect(useViewOptionsStore.getState().zebra).toBe(true)
    fireEvent.click(row('Curvature'))
    expect(useViewOptionsStore.getState().curvature).toBe(true)
    expect(useViewOptionsStore.getState().zebra).toBe(false)
  })

  it('shows Orbit around cursor on by default and flips it from the row', () => {
    const save = vi.spyOn(backendBundle.preferences, 'save').mockResolvedValue(undefined)
    render(<ViewOptionsButton />)
    open()

    expect(row('Orbit around cursor')).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(row('Orbit around cursor'))

    expect(useViewOptionsStore.getState().orbit_around_cursor).toBe(false)
    expect(row('Orbit around cursor')).toHaveAttribute('aria-checked', 'false')
    expect(save).toHaveBeenCalled()
  })

  it('shows the auto range, and a manual range overrides it', () => {
    useViewOptionsStore.setState({ curvatureAutoRange: [0.1, 0.3] })
    render(<ViewOptionsButton />)
    open()
    fireEvent.click(row('Curvature'))

    expect(screen.getByLabelText('Curvature legend').textContent).toContain('0.100 .. 0.300')
    expect(screen.getByLabelText('Curvature legend').textContent).toContain('(auto)')

    fireEvent.change(screen.getByLabelText('Curvature range minimum'), { target: { value: '0.05' } })
    expect(useViewOptionsStore.getState().curvature_range?.[0]).toBe(0.05)
    expect(screen.getByLabelText('Curvature legend').textContent).toContain('(manual)')

    fireEvent.click(screen.getByRole('button', { name: 'Auto' }))
    expect(useViewOptionsStore.getState().curvature_range).toBeNull()
    expect(screen.getByLabelText('Curvature legend').textContent).toContain('(auto)')
  })
})

describe('ViewOptionsButton document unit', () => {
  it('reflects the document unit and asks for one change when the other is chosen', () => {
    const onSetLengthUnit = vi.fn()
    render(<ViewOptionsButton lengthUnit="mm" onSetLengthUnit={onSetLengthUnit} />)
    open()

    expect(screen.getByRole('button', { name: 'millimetres' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'inches' })).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'inches' }))
    expect(onSetLengthUnit).toHaveBeenCalledTimes(1)
    expect(onSetLengthUnit).toHaveBeenCalledWith('inch')
  })

  it('emits nothing when the current unit is chosen again', () => {
    const onSetLengthUnit = vi.fn()
    render(<ViewOptionsButton lengthUnit="inch" onSetLengthUnit={onSetLengthUnit} />)
    open()

    expect(screen.getByRole('button', { name: 'inches' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'inches' }))
    expect(onSetLengthUnit).not.toHaveBeenCalled()
  })

  it('hides the unit when the page offers no document unit', () => {
    render(<ViewOptionsButton allowAmbientOcclusion={false} />)
    open()

    expect(screen.queryByText('Document')).toBeNull()
    expect(screen.queryByRole('group', { name: 'Length unit' })).toBeNull()
    // The viewer rows around it are still there.
    expect(row('Shading')).toBeInTheDocument()
  })
})

describe('ViewOptionsButton Section', () => {
  it('is the section on switch, with the controls moved to the section card', () => {
    render(<ViewOptionsButton />)
    open()

    expect(row('Section')).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(row('Section'))
    expect(useSectionStore.getState().enabled).toBe(true)

    // One surface owns the controls now; the dropdown only toggles the view.
    expect(screen.queryByRole('group', { name: 'Section plane' })).toBeNull()
    expect(screen.queryByLabelText('Section offset')).toBeNull()
    expect(screen.queryByText('Flip side')).toBeNull()
  })

  it('shows the reason an auto-disabled section turned off', () => {
    useSectionStore.setState({
      enabled: false,
      disabledReason: 'Section off: the picked plane or face no longer resolves after the solve.',
    })
    render(<ViewOptionsButton />)
    open()

    expect(screen.getByRole('status').textContent).toContain('no longer resolves')
  })

  it('toasts a pick reason even when the card is closed', () => {
    useSectionStore.setState({ enabled: true, pickError: 'Click a flat face or a reference plane.' })
    render(<ViewOptionsButton />)

    expect(h.notify).toHaveBeenCalledWith('Click a flat face or a reference plane.', 'warning')
  })
})

describe('ViewOptionsButton ambient occlusion', () => {
  it('shows only the AO toggle, with no Strength slider when AO is on', () => {
    useViewOptionsStore.setState({ ambient_occlusion: true })
    render(<ViewOptionsButton />)
    open()

    expect(row('Ambient occlusion')).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('slider', { name: 'Strength' })).toBeNull()
  })

  it('still toggles AO from the row and disables it when shading is off', () => {
    render(<ViewOptionsButton />)
    open()

    const ao = row('Ambient occlusion')
    expect(ao).not.toBeDisabled()
    fireEvent.click(ao)
    expect(useViewOptionsStore.getState().ambient_occlusion).toBe(true)
    expect(row('Ambient occlusion')).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(row('Shading'))
    expect(row('Ambient occlusion')).toBeDisabled()
    expect(useViewOptionsStore.getState().ambient_occlusion).toBe(false)
  })
})
