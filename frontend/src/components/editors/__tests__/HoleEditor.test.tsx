import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import { HOLE_SCHEMA } from '@/components/editors/featureEditorSchemas'
import type { PickFieldDef } from '@/components/editors/widgets/fieldTypes'
import { makeAncestryQuery } from '@/kernel/query'
import type { HoleFeature, HoleFeatureDef, PartFeature } from '@/types/cad'

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

  it('bottom select emits the drill-point tip, and the angle shows only for a point', () => {
    const onMutation = vi.fn()
    render(<FeatureEditor feature={makeFeature()} onMutation={onMutation} schema={HOLE_SCHEMA} />)
    expect(screen.queryByDisplayValue('118')).toBeNull()
    fireEvent.change(screen.getByDisplayValue('Flat'), { target: { value: 'drill_point' } })
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_hole_field', featureId: 'h1', field: 'tip', value: 'drill_point' })
  })

  it('a drill point shows its 118 degree default angle and edits it', () => {
    const onMutation = vi.fn()
    render(<FeatureEditor feature={makeFeature({ tip: 'drill_point' })} onMutation={onMutation} schema={HOLE_SCHEMA} />)
    const angle = screen.getByDisplayValue('118')
    fireEvent.change(angle, { target: { value: '135' } })
    fireEvent.blur(angle)
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_hole_field', featureId: 'h1', field: 'tip_angle', value: 135 })
  })

  it('a through hole hides the bottom fields', () => {
    const feature = makeFeature({ depth_mode: 'through_all', tip: 'drill_point' })
    render(<FeatureEditor feature={feature} onMutation={vi.fn()} schema={HOLE_SCHEMA} />)
    expect(screen.queryByDisplayValue('Drill point')).toBeNull()
    expect(screen.queryByDisplayValue('118')).toBeNull()
  })

  describe('sketch pick rule', () => {
    const sketchField = HOLE_SCHEMA.fields.find(
      (field): field is PickFieldDef => field.type === 'pick' && field.key === 'sketch',
    )!
    const sketch = {
      id: 'sk1',
      kind: 'sketch',
      plane: '@builtin_plane_front',
      entities: [
        { id: 'p1', kind: 'point' },
        { id: 'c1', kind: 'circle' },
        { id: 'cc', kind: 'circle', construction: true },
      ],
    } as PartFeature

    it('refuses a circle entity and names the extrude cut', () => {
      // A circle is a profile, not a drill site: a pick that lands on one must
      // say so instead of writing a ref the solve can only refuse.
      expect(sketchField.validatePick!('entity:sk1:c1', [sketch]))
        .toContain('circle, which is not a drill site')
      expect(sketchField.validatePick!('entity:sk1:c1', [sketch]))
        .toContain('extrude cut')
    })

    it('tells a construction circle to clear its flag first', () => {
      expect(sketchField.validatePick!('entity:sk1:cc', [sketch]))
        .toContain("clear the circle's construction flag, then cut it with an extrude cut")
    })

    it('refuses an area pick naming a lone circle', () => {
      // The area form is the other way a circle reaches the chip; it must not
      // survive until the solve only because it is not an entity: id.
      const query = makeAncestryQuery(['@sk1/c1', 'surface:0', '@sk1'], 'flatface')
      expect(sketchField.validatePick!(query, [sketch]))
        .toContain('circle, which is not a drill site')
      const construction = makeAncestryQuery(['@sk1/cc', 'surface:0', '@sk1'], 'flatface')
      expect(sketchField.validatePick!(construction, [sketch]))
        .toContain("clear the circle's construction flag")
    })

    it('accepts a point and a whole-sketch ref', () => {
      expect(sketchField.validatePick!('entity:sk1:p1', [sketch])).toBeNull()
      expect(sketchField.validatePick!('@sk1', [sketch])).toBeNull()
      // A multi-entity area names no single drill site, so it keeps the
      // whole-sketch meaning and is accepted for the solve to narrow.
      const rectangle = makeAncestryQuery(['@sk1/p1', '@sk1/c1', 'surface:0', '@sk1'], 'flatface')
      expect(sketchField.validatePick!(rectangle, [sketch])).toBeNull()
      // Without the feature list the rule has nothing to look the id up in and
      // lets the pick through, like the build-order guard.
      expect(sketchField.validatePick!('entity:sk1:c1')).toBeNull()
    })
  })

  describe('thread depth', () => {
    const M6 = { designation: 'M6x1', nominal: 6, pitch: 1 }
    const tapFull = () => screen.queryByLabelText('Tap full depth') as HTMLInputElement | null

    it('shows nothing about the tapped depth without a thread', () => {
      render(<FeatureEditor feature={makeFeature()} onMutation={vi.fn()} schema={HOLE_SCHEMA} />)
      expect(tapFull()).toBeNull()
      expect(screen.queryByLabelText('Thread depth')).toBeNull()
    })

    it('taps the full bore by default and hides the number', () => {
      render(<FeatureEditor feature={makeFeature({ thread: M6 })} onMutation={vi.fn()} schema={HOLE_SCHEMA} />)
      expect(tapFull()?.checked).toBe(true)
      expect(screen.queryByLabelText('Thread depth')).toBeNull()
    })

    it('unchecking seeds the blind depth, so the shading does not move yet', () => {
      const onMutation = vi.fn()
      render(<FeatureEditor feature={makeFeature({ thread: M6 })} onMutation={onMutation} schema={HOLE_SCHEMA} />)
      fireEvent.click(tapFull()!)
      expect(onMutation).toHaveBeenCalledWith({ type: 'set_hole_field', featureId: 'h1', field: 'thread_depth', value: 20 })
    })

    it('a through hole seeds the fallback, having no depth to copy', () => {
      const onMutation = vi.fn()
      const feature = makeFeature({ thread: M6, depth_mode: 'through_all', depth: undefined })
      render(<FeatureEditor feature={feature} onMutation={onMutation} schema={HOLE_SCHEMA} />)
      fireEvent.click(tapFull()!)
      expect(onMutation).toHaveBeenCalledWith({ type: 'set_hole_field', featureId: 'h1', field: 'thread_depth', value: 10 })
    })

    it('edits a stored depth, and checking full depth clears it', () => {
      const onMutation = vi.fn()
      render(<FeatureEditor feature={makeFeature({ thread: M6, thread_depth: 15 })} onMutation={onMutation} schema={HOLE_SCHEMA} />)
      expect(tapFull()?.checked).toBe(false)
      const input = screen.getByDisplayValue('15')
      fireEvent.change(input, { target: { value: '12' } })
      fireEvent.blur(input)
      expect(onMutation).toHaveBeenCalledWith({ type: 'set_hole_field', featureId: 'h1', field: 'thread_depth', value: 12 })
      fireEvent.click(tapFull()!)
      expect(onMutation).toHaveBeenCalledWith({ type: 'set_hole_field', featureId: 'h1', field: 'thread_depth', value: null })
    })
  })
})
