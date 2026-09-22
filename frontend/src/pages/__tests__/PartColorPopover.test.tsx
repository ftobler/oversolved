// The color popover's inner editing surface, rendered on its own. The page
// suites drive only open/apply/cancel through the context menu; the drafts, the
// per-slider setters, the swatch row and the keyboard handling live here.
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import PartColorPopover from '@/pages/PartColorPopover'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { PART_COLOR_PALETTE } from '@/utils/core/partColors'

const STYLED = {
  b1: {
    name: 'Body',
    color: '#123456',
    transparency: 0.3,
    metalness: 0.4,
    roughness: 0.2,
    transmission: 0.1,
  },
}

function renderPopover(session?: number) {
  const handlers = {
    onColorSet: vi.fn(),
    onTransparencySet: vi.fn(),
    onMetalnessSet: vi.fn(),
    onRoughnessSet: vi.fn(),
    onTransmissionSet: vi.fn(),
    onCancel: vi.fn(),
    onApply: vi.fn(),
  }
  const view = render(
    <PartColorPopover
      popover={{ bodyId: 'b1', position: [100, 200], session }}
      {...handlers}
    />,
  )
  return { handlers, ...view }
}

const colorInput = () => screen.getByRole('textbox') as HTMLInputElement
const sliders = () => screen.getAllByRole('slider') as HTMLInputElement[]
const popoverEl = () => document.querySelector('.part-color-popover') as HTMLElement

describe('PartColorPopover', () => {
  beforeEach(() => {
    usePartEditorStore.setState({ partStyle: STYLED })
  })

  afterEach(cleanup)

  it('seeds every draft from the body style already stored', () => {
    renderPopover()
    expect(colorInput().value).toBe('#123456')
    expect(sliders().map(s => s.value)).toEqual(['0.3', '0.4', '0.2', '0.1'])
  })

  it('a valid typed color commits live, an invalid one does not', () => {
    const { handlers } = renderPopover()
    fireEvent.change(colorInput(), { target: { value: '#00ff00' } })
    expect(handlers.onColorSet).toHaveBeenCalledWith('b1', '#00FF00')

    handlers.onColorSet.mockClear()
    fireEvent.change(colorInput(), { target: { value: 'nope' } })
    expect(handlers.onColorSet).not.toHaveBeenCalled()
  })

  it('Enter applies the typed color as a preview commit', () => {
    const { handlers } = renderPopover()
    fireEvent.change(colorInput(), { target: { value: '#00ff00' } })
    fireEvent.keyDown(colorInput(), { key: 'Enter' })
    expect(handlers.onApply).toHaveBeenCalledWith({
      type: 'set_part_color',
      bodyId: 'b1',
      color: '#00FF00',
    })
  })

  it('Enter with an unparseable color applies nothing', () => {
    const { handlers } = renderPopover()
    fireEvent.change(colorInput(), { target: { value: 'zzz' } })
    fireEvent.keyDown(colorInput(), { key: 'Enter' })
    expect(handlers.onApply).not.toHaveBeenCalled()
  })

  it('each material slider commits its own field by name', () => {
    const { handlers } = renderPopover()
    const [opacity, metalness, roughness, transmission] = sliders()

    fireEvent.change(opacity, { target: { value: '0.75' } })
    fireEvent.change(metalness, { target: { value: '0.25' } })
    fireEvent.change(roughness, { target: { value: '0.5' } })
    fireEvent.change(transmission, { target: { value: '0.9' } })

    expect(handlers.onTransparencySet).toHaveBeenCalledWith('b1', 0.75)
    expect(handlers.onMetalnessSet).toHaveBeenCalledWith('b1', 0.25)
    expect(handlers.onRoughnessSet).toHaveBeenCalledWith('b1', 0.5)
    expect(handlers.onTransmissionSet).toHaveBeenCalledWith('b1', 0.9)
  })

  it('clicking a swatch both updates the draft and commits it', () => {
    const { handlers } = renderPopover()
    fireEvent.click(screen.getAllByTitle(PART_COLOR_PALETTE[1])[0])
    expect(colorInput().value).toBe(PART_COLOR_PALETTE[1])
    expect(handlers.onColorSet).toHaveBeenCalledWith('b1', PART_COLOR_PALETTE[1])
  })

  it('Apply is disabled for an unparseable draft and commits the parsed color when valid', () => {
    const { handlers } = renderPopover()
    fireEvent.change(colorInput(), { target: { value: 'nope' } })
    expect(screen.getByText('Apply')).toBeDisabled()

    fireEvent.change(colorInput(), { target: { value: '#abcdef' } })
    const apply = screen.getByText('Apply')
    expect(apply).not.toBeDisabled()
    fireEvent.click(apply)
    expect(handlers.onApply).toHaveBeenCalledWith({
      type: 'set_part_color',
      bodyId: 'b1',
      color: '#ABCDEF',
    })
  })

  it('Escape cancels the popover', () => {
    const { handlers } = renderPopover()
    fireEvent.keyDown(popoverEl(), { key: 'Escape' })
    expect(handlers.onCancel).toHaveBeenCalledTimes(1)
  })

  it('Tab wraps from the last control to the first, Shift+Tab the other way', () => {
    renderPopover()
    const close = screen.getByTitle('Close')
    const cancel = screen.getByText('Cancel')

    cancel.focus()
    fireEvent.keyDown(popoverEl(), { key: 'Tab' })
    expect(document.activeElement).toBe(close)

    close.focus()
    fireEvent.keyDown(popoverEl(), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(cancel)
  })

  it('reopening the same body with a new session remounts with fresh drafts', () => {
    const { rerender } = renderPopover(1)
    fireEvent.change(colorInput(), { target: { value: '#00ff00' } })
    expect(colorInput().value).toBe('#00FF00')

    rerender(
      <PartColorPopover
        popover={{ bodyId: 'b1', position: [100, 200], session: 2 }}
        onColorSet={vi.fn()}
        onTransparencySet={vi.fn()}
        onMetalnessSet={vi.fn()}
        onRoughnessSet={vi.fn()}
        onTransmissionSet={vi.fn()}
        onCancel={vi.fn()}
        onApply={vi.fn()}
      />,
    )
    expect(colorInput().value).toBe('#123456')
  })
})
