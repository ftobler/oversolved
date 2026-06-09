import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { HoleEditor } from '@/components/editors/HoleEditor'
import type { PartFeature } from '@/types/cad'

function makeFeature(overrides: Partial<PartFeature['hole']> = {}): PartFeature {
  return {
    id: 'h1',
    kind: 'hole',
    hole: {
      sketch: '',
      diameter: 10,
      depth_mode: 'blind',
      depth: 20,
      direction: 'normal',
      ...overrides,
    },
  }
}

describe('HoleEditor', () => {
  it('renders "(none)" when sketch is empty', () => {
    const feature = makeFeature()
    render(<HoleEditor feature={feature} onMutation={vi.fn()} />)
    expect(document.querySelector('.feature-pick-chip.empty')).toBeTruthy()
  })

  it('renders sketch chip when sketch is set', () => {
    const feature = makeFeature({ sketch: '@sk1' })
    render(<HoleEditor feature={feature} onMutation={vi.fn()} />)
    const chip = document.querySelector('.feature-pick-chip-item-text')
    expect(chip?.textContent).toBe('@sk1')
  })

  it('clicking sketch chip toggles picking state', () => {
    const feature = makeFeature()
    render(<HoleEditor feature={feature} onMutation={vi.fn()} />)
    const chip = document.querySelector('.feature-pick-chip')!
    expect(chip.classList.contains('picking')).toBe(false)
    fireEvent.click(chip)
    expect(chip.classList.contains('picking')).toBe(true)
    fireEvent.click(chip)
    expect(chip.classList.contains('picking')).toBe(false)
  })

  it('diameter input change emits set_hole_diameter', () => {
    const feature = makeFeature()
    const onMutation = vi.fn()
    render(<HoleEditor feature={feature} onMutation={onMutation} />)
    const input = screen.getByDisplayValue('10')
    fireEvent.change(input, { target: { value: '15' } })
    fireEvent.blur(input)
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_hole_field', featureId: 'h1', field: 'diameter', value: 15 })
  })

  it('depth mode toggle emits set_hole_depth_mode', () => {
    const feature = makeFeature()
    const onMutation = vi.fn()
    render(<HoleEditor feature={feature} onMutation={onMutation} />)
    const select = screen.getByDisplayValue('Blind')
    fireEvent.change(select, { target: { value: 'through_all' } })
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_hole_field', featureId: 'h1', field: 'depth_mode', value: 'through_all' })
  })

  it('hides depth input when depth_mode is through_all', () => {
    const feature = makeFeature({ depth_mode: 'through_all' })
    render(<HoleEditor feature={feature} onMutation={vi.fn()} />)
    expect(screen.queryByDisplayValue('20')).toBeNull()
  })

  it('depth input change emits set_hole_depth', () => {
    const feature = makeFeature()
    const onMutation = vi.fn()
    render(<HoleEditor feature={feature} onMutation={onMutation} />)
    const input = screen.getByDisplayValue('20')
    fireEvent.change(input, { target: { value: '30' } })
    fireEvent.blur(input)
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_hole_field', featureId: 'h1', field: 'depth', value: 30 })
  })

  it('direction toggle emits set_hole_direction', () => {
    const feature = makeFeature()
    const onMutation = vi.fn()
    render(<HoleEditor feature={feature} onMutation={onMutation} />)
    const select = screen.getByDisplayValue('Normal')
    fireEvent.change(select, { target: { value: 'reverse' } })
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_hole_field', featureId: 'h1', field: 'direction', value: 'reverse' })
  })
})
