// The mate roll-angle control. `angle` is authored in [0, 360) and the +/-90
// buttons step forever: the range guard these replace made `+90` at 180 a
// no-op that could only raise an error, even though the solver's roll residual
// wraps the difference and cannot tell 270 from -90 (mate_residuals.rs
// abs_roll_residual). The normalisation itself lives in mateKinds.ts and is
// unit-tested there; this covers the editor's wiring to it.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MateEditor } from '@/components/layout/MateEditor'
import type { MateFeatureDef } from '@/types/cad'

function mate(overrides: Partial<MateFeatureDef> = {}): MateFeatureDef {
  return {
    kind: 'fixed',
    ref_a: { part: 'h1', anchor: 'a1' },
    ref_b: { part: 'h2', anchor: 'b1' },
    ...overrides,
  }
}

function renderEditor(m: MateFeatureDef, onUpdate = vi.fn()) {
  const utils = render(
    <MateEditor
      featureId="m1"
      mate={m}
      activeField={null}
      defaultName="Fixed 1"
      onArmField={vi.fn()}
      onUpdate={onUpdate}
      onRename={vi.fn()}
    />
  )
  return { onUpdate, ...utils }
}

const angleBox = () => screen.getByLabelText('Angle') as HTMLInputElement
const plus90 = () => screen.getByRole('button', { name: /\+90/ })
const minus90 = () => screen.getByRole('button', { name: /-90/ })

describe('MateEditor angle buttons', () => {
  it('steps +90 forever, wrapping a full turn back to zero', () => {
    // The bug this replaces: at 180 the guard rejected 270 outright, so the
    // button dead-ended one press short of a full turn.
    for (const [from, to] of [[0, 90], [90, 180], [180, 270], [270, 0]] as const) {
      const { onUpdate, unmount } = renderEditor(mate({ angle: from }))
      fireEvent.click(plus90())
      expect(onUpdate).toHaveBeenCalledWith({ angle: to })
      unmount()
    }
  })

  it('steps -90 below zero into the top of the range', () => {
    const { onUpdate } = renderEditor(mate({ angle: 0 }))
    fireEvent.click(minus90())
    expect(onUpdate).toHaveBeenCalledWith({ angle: 270 })
  })

  it('treats a mate with no authored angle as zero', () => {
    const { onUpdate } = renderEditor(mate())
    fireEvent.click(plus90())
    expect(onUpdate).toHaveBeenCalledWith({ angle: 90 })
  })

  it('normalises a legacy out-of-range angle on the first press', () => {
    const { onUpdate } = renderEditor(mate({ angle: 400 }))
    fireEvent.click(plus90())
    expect(onUpdate).toHaveBeenCalledWith({ angle: 130 })
  })
})

describe('MateEditor angle box', () => {
  it('accepts an overflowing value and cleans it up when entry ends', () => {
    const { onUpdate } = renderEditor(mate({ angle: 0 }))
    fireEvent.change(angleBox(), { target: { value: '400' } })
    fireEvent.blur(angleBox())
    expect(onUpdate).toHaveBeenLastCalledWith({ angle: 40 })
    expect(angleBox().value).toBe('40')
  })

  it('folds a typed negative up into the range', () => {
    const { onUpdate } = renderEditor(mate({ angle: 0 }))
    fireEvent.change(angleBox(), { target: { value: '-90' } })
    fireEvent.blur(angleBox())
    expect(onUpdate).toHaveBeenLastCalledWith({ angle: 270 })
  })

  it('leaves a negative typeable while the user is still typing it', () => {
    // Why normalisation waits for blur: '-9' is the halfway state of typing
    // '-90', and rewriting it to 351 per keystroke would move the caret out
    // from under the user and make a negative impossible to finish entering.
    renderEditor(mate({ angle: 0 }))
    fireEvent.change(angleBox(), { target: { value: '-9' } })
    expect(angleBox().value).toBe('-9')
  })

  it('keeps a value already inside the range exactly as typed', () => {
    const { onUpdate } = renderEditor(mate({ angle: 0 }))
    fireEvent.change(angleBox(), { target: { value: '270' } })
    fireEvent.blur(angleBox())
    expect(onUpdate).toHaveBeenLastCalledWith({ angle: 270 })
  })

  it('unsets the angle when the box is emptied, rather than authoring zero', () => {
    const { onUpdate } = renderEditor(mate({ angle: 90 }))
    fireEvent.change(angleBox(), { target: { value: '' } })
    expect(onUpdate).toHaveBeenLastCalledWith({ angle: undefined })
    fireEvent.blur(angleBox())
    expect(onUpdate).toHaveBeenLastCalledWith({ angle: undefined })
  })

  it('never authors an angle from unparseable text', () => {
    // `type="number"` sanitises garbage to an empty value before React sees it,
    // so the box reads as "unset" rather than as a number; blur must not then
    // resurrect it as 0 (normalizeMateAngleDeg's NaN floor) behind the user.
    const { onUpdate } = renderEditor(mate({ angle: 90 }))
    fireEvent.change(angleBox(), { target: { value: 'abc' } })
    fireEvent.blur(angleBox())
    for (const call of onUpdate.mock.calls) expect(call[0]).toEqual({ angle: undefined })
  })
})
