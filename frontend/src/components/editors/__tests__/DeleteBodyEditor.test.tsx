import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { DeleteBodyEditor } from '@/components/editors/DeleteBodyEditor'
import type { PartFeature } from '@/types/cad'

function makeFeature(body = ''): PartFeature {
  return {
    id: 'db1',
    kind: 'delete_body',
    label: 'Delete Body',
    delete_body: { body },
  }
}

describe('DeleteBodyEditor', () => {
  it('renders empty chip when no body selected', () => {
    const feature = makeFeature()
    render(<DeleteBodyEditor feature={feature} onMutation={vi.fn()} />)
    expect(document.querySelector('.feature-pick-chip.empty')).toBeTruthy()
  })

  it('renders body ref when set', () => {
    const feature = makeFeature('@body_ex1')
    render(<DeleteBodyEditor feature={feature} onMutation={vi.fn()} />)
    const chip = document.querySelector('.feature-pick-chip-item-text')
    expect(chip?.textContent).toBe('@body_ex1')
  })

  it('clicking chip toggles picking state', () => {
    const feature = makeFeature()
    render(<DeleteBodyEditor feature={feature} onMutation={vi.fn()} />)
    const chip = document.querySelector('.feature-pick-chip')!
    expect(chip.classList.contains('picking')).toBe(false)
    fireEvent.click(chip)
    expect(chip.classList.contains('picking')).toBe(true)
    fireEvent.click(chip)
    expect(chip.classList.contains('picking')).toBe(false)
  })

  it('remove button emits set_delete_body_target', () => {
    const feature = makeFeature('@body_ex1')
    const onMutation = vi.fn()
    render(<DeleteBodyEditor feature={feature} onMutation={onMutation} />)
    const removeBtn = document.querySelector('.feature-pick-chip-item-remove')!
    fireEvent.click(removeBtn)
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_delete_body_field', featureId: 'db1', field: 'body', value: '' })
  })
})
