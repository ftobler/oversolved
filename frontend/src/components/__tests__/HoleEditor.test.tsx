import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { HoleEditor } from '@/components/HoleEditor'
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
    render(<HoleEditor feature={feature} onMutation={vi.fn()} pendingPickField={null} setPendingPickField={vi.fn()} />)
    expect(document.querySelector('.feature-pick-chip.empty')).toBeTruthy()
  })

  it('renders sketch chip when sketch is set', () => {
    const feature = makeFeature({ sketch: '@sk1' })
    render(<HoleEditor feature={feature} onMutation={vi.fn()} pendingPickField={null} setPendingPickField={vi.fn()} />)
    const chip = document.querySelector('.feature-pick-chip-item-text')
    expect(chip?.textContent).toBe('@sk1')
  })

  it('clicking sketch chip sets pendingPickField with hostKind hole', () => {
    const feature = makeFeature()
    const setPending = vi.fn()
    render(<HoleEditor feature={feature} onMutation={vi.fn()} pendingPickField={null} setPendingPickField={setPending} />)
    const chip = document.querySelector('.feature-pick-chip')!
    fireEvent.click(chip)
    expect(setPending).toHaveBeenCalledWith({ featureId: 'h1', field: 'sketch', hostKind: 'hole' })
  })

  it('diameter input change emits set_hole_diameter', () => {
    const feature = makeFeature()
    const onMutation = vi.fn()
    render(<HoleEditor feature={feature} onMutation={onMutation} pendingPickField={null} setPendingPickField={vi.fn()} />)
    const input = screen.getByDisplayValue('10')
    fireEvent.change(input, { target: { value: '15' } })
    fireEvent.blur(input)
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_hole_diameter', featureId: 'h1', diameter: 15 })
  })

  it('depth mode toggle emits set_hole_depth_mode', () => {
    const feature = makeFeature()
    const onMutation = vi.fn()
    render(<HoleEditor feature={feature} onMutation={onMutation} pendingPickField={null} setPendingPickField={vi.fn()} />)
    const select = screen.getByDisplayValue('Blind')
    fireEvent.change(select, { target: { value: 'through_all' } })
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_hole_depth_mode', featureId: 'h1', depthMode: 'through_all' })
  })

  it('hides depth input when depth_mode is through_all', () => {
    const feature = makeFeature({ depth_mode: 'through_all' })
    render(<HoleEditor feature={feature} onMutation={vi.fn()} pendingPickField={null} setPendingPickField={vi.fn()} />)
    expect(screen.queryByDisplayValue('20')).toBeNull()
  })

  it('depth input change emits set_hole_depth', () => {
    const feature = makeFeature()
    const onMutation = vi.fn()
    render(<HoleEditor feature={feature} onMutation={onMutation} pendingPickField={null} setPendingPickField={vi.fn()} />)
    const input = screen.getByDisplayValue('20')
    fireEvent.change(input, { target: { value: '30' } })
    fireEvent.blur(input)
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_hole_depth', featureId: 'h1', depth: 30 })
  })

  it('direction toggle emits set_hole_direction', () => {
    const feature = makeFeature()
    const onMutation = vi.fn()
    render(<HoleEditor feature={feature} onMutation={onMutation} pendingPickField={null} setPendingPickField={vi.fn()} />)
    const select = screen.getByDisplayValue('Normal')
    fireEvent.change(select, { target: { value: 'reverse' } })
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_hole_direction', featureId: 'h1', direction: 'reverse' })
  })
})
