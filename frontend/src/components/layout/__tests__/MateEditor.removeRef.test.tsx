// A mate reference field looks like a pick chip, so it must offer the same
// Remove affordance. The shared chip markup lives in PickChip; this panel stays
// presentational and hands the clear and the re-arm back to the page.

import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MateEditor } from '@/components/layout/MateEditor'
import type { MateFeatureDef } from '@/types/cad'

function mateWith(a: { part: string; anchor: string }, b: { part: string; anchor: string }): MateFeatureDef {
  return { kind: 'fixed', ref_a: a, ref_b: b }
}

function renderEditor(mate: MateFeatureDef, activeField: { featureId: string; field: 'ref_a' | 'ref_b' } | null = null) {
  const onClearRef = vi.fn()
  const onArmField = vi.fn()
  const onUpdate = vi.fn()
  render(
    <MateEditor
      featureId="m1"
      mate={mate}
      activeField={activeField}
      labelFor={handle => (handle === 'h1' ? 'Bracket' : undefined)}
      kindOf={() => 'plane'}
      onClearRef={onClearRef}
      onArmField={onArmField}
      onUpdate={onUpdate}
    />,
  )
  return { onClearRef, onArmField, onUpdate }
}

const PICKED = { part: 'h1', anchor: 'plane-a' }
const EMPTY = { part: '', anchor: '' }

describe('MateEditor reference removal', () => {
  it('shows a Remove button inside a filled chip', () => {
    renderEditor(mateWith(PICKED, EMPTY))
    const remove = screen.getByTitle('Remove')
    expect(remove.classList.contains('feature-pick-chip-item-remove')).toBe(true)
    expect(remove.closest('.feature-pick-chip-item')?.textContent).toContain('Face of Bracket')
  })

  it('clears the named slot and arms it without toggling the chip', () => {
    const { onClearRef, onArmField } = renderEditor(mateWith(PICKED, EMPTY))
    fireEvent.click(screen.getByTitle('Remove'))
    expect(onClearRef).toHaveBeenCalledWith('ref_a')
    // The remove click must not also bubble to the chip's own arm/toggle handler.
    expect(onArmField).toHaveBeenCalledTimes(1)
    expect(onArmField).toHaveBeenCalledWith({ featureId: 'm1', field: 'ref_a' })
  })

  it('arms the slot the remove button belongs to, not the other one', () => {
    const { onClearRef, onArmField } = renderEditor(mateWith(PICKED, { part: 'h2', anchor: 'plane-b' }))
    const removes = screen.getAllByTitle('Remove')
    fireEvent.click(removes[1])
    expect(onClearRef).toHaveBeenCalledWith('ref_b')
    expect(onArmField).toHaveBeenCalledWith({ featureId: 'm1', field: 'ref_b' })
  })

  it('shows no Remove button on an empty slot', () => {
    renderEditor(mateWith(EMPTY, EMPTY))
    expect(screen.queryByTitle('Remove')).toBeNull()
  })

  it('arms a chip from the keyboard as well as a click', () => {
    const { onArmField } = renderEditor(mateWith(PICKED, EMPTY))
    const chip = document.querySelector('.mate-ref-chip') as HTMLElement
    fireEvent.keyDown(chip, { key: 'Enter' })
    expect(onArmField).toHaveBeenCalledWith({ featureId: 'm1', field: 'ref_a' })
  })
})
