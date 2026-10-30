// A rotating mate's angle is an opt-in lock on the hinge roll: an empty box
// means free (no key), a number writes the key, and clearing it deletes the key
// again. The distinction matters because a hinge locked at 0 is not a free one.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MateEditor } from '@/components/layout/MateEditor'
import type { MateFeatureDef } from '@/types/cad'

function mate(overrides: Partial<MateFeatureDef> = {}): MateFeatureDef {
  return {
    kind: 'rotating',
    ref_a: { part: 'h1', anchor: 'a1' },
    ref_b: { part: 'h2', anchor: 'b1' },
    ...overrides,
  }
}

function renderEditor(m: MateFeatureDef) {
  const onUpdate = vi.fn()
  render(
    <MateEditor featureId="m1" mate={m} activeField={null} onArmField={vi.fn()} onUpdate={onUpdate} />,
  )
  return onUpdate
}

const angleBox = () => screen.getByLabelText('Angle') as HTMLInputElement

describe('MateEditor rotating angle', () => {
  it('shows the angle box empty for a free hinge', () => {
    renderEditor(mate())
    expect(angleBox().value).toBe('')
  })

  it('shows a locked angle', () => {
    renderEditor(mate({ angle: 120 }))
    expect(angleBox().value).toBe('120')
  })

  it('writes a typed number', () => {
    const onUpdate = renderEditor(mate())
    fireEvent.change(angleBox(), { target: { value: '120' } })
    expect(onUpdate).toHaveBeenCalledWith({ angle: 120 })
  })

  it('clearing the box deletes the key, freeing the hinge', () => {
    const onUpdate = renderEditor(mate({ angle: 120 }))
    fireEvent.change(angleBox(), { target: { value: '' } })
    expect(onUpdate).toHaveBeenCalledWith({ angle: undefined })
  })

  it('offers one axial offset box, not an x/y/z triple', () => {
    renderEditor(mate())
    expect(screen.getByLabelText('Offset')).toBeTruthy()
    expect(screen.queryByLabelText('Offset X')).toBeNull()
  })
})
