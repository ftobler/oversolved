import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import { HOLE_SCHEMA } from '@/components/editors/featureEditorSchemas'
import type { HoleFeature, HoleFeatureDef } from '@/types/cad'

function makeFeature(overrides: Partial<HoleFeatureDef> = {}): HoleFeature {
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

describe('HoleEditor (via FeatureEditor)', () => {
  it('renders "(none)" when sketch is empty', () => {
    const feature = makeFeature()
    render(<FeatureEditor feature={feature} onMutation={vi.fn()} schema={HOLE_SCHEMA} />)
    expect(document.querySelector('.feature-pick-chip.empty')).toBeTruthy()
  })

  it('renders sketch chip when sketch is set', () => {
    const feature = makeFeature({ sketch: '@sk1' })
    render(<FeatureEditor feature={feature} onMutation={vi.fn()} schema={HOLE_SCHEMA} />)
    const chip = document.querySelector('.feature-pick-chip-item-text')
    expect(chip?.textContent).toBe('@sk1')
  })

  it('clicking sketch chip toggles picking state', () => {
    const feature = makeFeature()
    render(<FeatureEditor feature={feature} onMutation={vi.fn()} schema={HOLE_SCHEMA} />)
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
    render(<FeatureEditor feature={feature} onMutation={onMutation} schema={HOLE_SCHEMA} />)
    const input = screen.getByDisplayValue('10')
    fireEvent.change(input, { target: { value: '15' } })
    fireEvent.blur(input)
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_hole_field', featureId: 'h1', field: 'diameter', value: 15 })
  })

  it('depth mode toggle emits set_hole_depth_mode', () => {
    const feature = makeFeature()
    const onMutation = vi.fn()
    render(<FeatureEditor feature={feature} onMutation={onMutation} schema={HOLE_SCHEMA} />)
    const select = screen.getByDisplayValue('Blind')
    fireEvent.change(select, { target: { value: 'through_all' } })
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_hole_field', featureId: 'h1', field: 'depth_mode', value: 'through_all' })
  })

  it('hides depth input when depth_mode is through_all', () => {
    const feature = makeFeature({ depth_mode: 'through_all' })
    render(<FeatureEditor feature={feature} onMutation={vi.fn()} schema={HOLE_SCHEMA} />)
    expect(screen.queryByDisplayValue('20')).toBeNull()
  })

  it('depth input change emits set_hole_depth', () => {
    const feature = makeFeature()
    const onMutation = vi.fn()
    render(<FeatureEditor feature={feature} onMutation={onMutation} schema={HOLE_SCHEMA} />)
    const input = screen.getByDisplayValue('20')
    fireEvent.change(input, { target: { value: '30' } })
    fireEvent.blur(input)
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_hole_field', featureId: 'h1', field: 'depth', value: 30 })
  })

  it('direction toggle emits set_hole_direction', () => {
    const feature = makeFeature()
    const onMutation = vi.fn()
    render(<FeatureEditor feature={feature} onMutation={onMutation} schema={HOLE_SCHEMA} />)
    const select = screen.getByDisplayValue('Normal')
    fireEvent.change(select, { target: { value: 'reverse' } })
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_hole_field', featureId: 'h1', field: 'direction', value: 'reverse' })
  })

  it('style select emits set_hole_style', () => {
    const feature = makeFeature()
    const onMutation = vi.fn()
    render(<FeatureEditor feature={feature} onMutation={onMutation} schema={HOLE_SCHEMA} />)
    const select = screen.getByDisplayValue('Simple')
    fireEvent.change(select, { target: { value: 'counterbore' } })
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_hole_field', featureId: 'h1', field: 'style', value: 'counterbore' })
  })

  it('a counterbore shows its mouth diameter and step depth', () => {
    const feature = makeFeature({ style: 'counterbore', cb_diameter: 16, cb_depth: 3 })
    const onMutation = vi.fn()
    render(<FeatureEditor feature={feature} onMutation={onMutation} schema={HOLE_SCHEMA} />)
    const diameter = screen.getByDisplayValue('16')
    fireEvent.change(diameter, { target: { value: '18' } })
    fireEvent.blur(diameter)
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_hole_field', featureId: 'h1', field: 'cb_diameter', value: 18 })
    const step = screen.getByDisplayValue('3')
    fireEvent.change(step, { target: { value: '4' } })
    fireEvent.blur(step)
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_hole_field', featureId: 'h1', field: 'cb_depth', value: 4 })
  })

  it('a countersink shows the angle and hides the step depth', () => {
    const feature = makeFeature({ style: 'countersink', cb_diameter: 16, cs_angle: 90 })
    const onMutation = vi.fn()
    render(<FeatureEditor feature={feature} onMutation={onMutation} schema={HOLE_SCHEMA} />)
    // The default step depth (3) is not rendered for a countersink.
    expect(screen.queryByDisplayValue('3')).toBeNull()
    const angle = screen.getByDisplayValue('90')
    fireEvent.change(angle, { target: { value: '82' } })
    fireEvent.blur(angle)
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_hole_field', featureId: 'h1', field: 'cs_angle', value: 82 })
  })
})
