import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NumberFieldWidget } from './NumberField'
import type { NumberFieldDef } from './fieldTypes'

const field: NumberFieldDef = {
  type: 'number', key: 'count', label: 'Count', parse: 'int', validate: (v) => v > 0, min: 1,
}

const baseProps = {
  field,
  fid: 'f1',
  value: 2,
  mutationType: 'set_test_field',
}

describe('NumberFieldWidget wheel step', () => {
  it('steps a schema field down once, then holds at the boundary', () => {
    const onMutation = vi.fn()
    const { rerender } = render(<NumberFieldWidget {...baseProps} onMutation={onMutation} />)
    const input = screen.getByRole('textbox', { name: 'Count' }) as HTMLInputElement
    fireEvent.wheel(input, { deltaY: 100 })
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_test_field', featureId: 'f1', field: 'count', value: 1 })
    // The host re-renders with the committed value (as the real editor does);
    // a second notch now reads 1 and is refused at the min.
    rerender(<NumberFieldWidget {...baseProps} value={1} onMutation={onMutation} />)
    fireEvent.wheel(input, { deltaY: 100 })
    expect(onMutation).toHaveBeenCalledTimes(1)
  })
})
