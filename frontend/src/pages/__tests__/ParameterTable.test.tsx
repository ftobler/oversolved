// The parameter table dialog: it renders one row per variable, commits an
// edited cell on blur (never per keystroke), abandons the draft on Escape, and
// appends a parameter through the caller's own mutation. Every write leaves as
// the cell's mutation, so the dialog holds no document knowledge of its own.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ParameterTable from '@/pages/ParameterTable'
import { isValidVariableName } from '@/kernel/features/variable'
import type { ParameterRow } from '@/pages/partParameters'

const rows: ParameterRow[] = [
  { id: 'v1', name: 'width', expression: '20', unit: 'mm', value: 20, error: null },
  { id: 'v2', name: 'height', expression: 'width/2', unit: '', value: null, error: 'Cannot evaluate "width/2"' },
  { id: 'v3', name: 'depth', expression: '10', unit: 'mm', value: null, error: null },
]

function open(over: { rows?: ParameterRow[] } = {}) {
  const onMutation = vi.fn()
  const onClose = vi.fn()
  const onAdd = vi.fn()
  const utils = render(
    <ParameterTable
      isOpen
      rows={over.rows ?? rows}
      onClose={onClose}
      onMutation={onMutation}
      onAdd={onAdd}
    />,
  )
  return { onMutation, onClose, onAdd, ...utils }
}

describe('ParameterTable', () => {
  it('renders a row per parameter with the solved value and the error', () => {
    open()
    expect((screen.getByLabelText('Name of width') as HTMLInputElement).value).toBe('width')
    expect((screen.getByLabelText('Expression of width') as HTMLInputElement).value).toBe('20')
    expect((screen.getByLabelText('Unit of width') as HTMLInputElement).value).toBe('mm')
    expect(screen.getByText('20')).toBeInTheDocument()
    expect(screen.getByText('Cannot evaluate "width/2"')).toBeInTheDocument()
    // A row whose solve has not landed shows the placeholder.
    expect(screen.getByText('...')).toBeInTheDocument()
  })

  it('commits an edited expression on blur, once', () => {
    const { onMutation } = open()
    const field = screen.getByLabelText('Expression of width')
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: 'width + 5' } })
    expect(onMutation).not.toHaveBeenCalled()
    fireEvent.blur(field)
    expect(onMutation).toHaveBeenCalledTimes(1)
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_variable_field', featureId: 'v1', field: 'expression', value: 'width + 5',
    })
  })

  it('does not write when the text came back unchanged', () => {
    const { onMutation } = open()
    const field = screen.getByLabelText('Name of width')
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: 'width' } })
    fireEvent.blur(field)
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('renames through rename_feature and clears the unit through the null value', () => {
    const { onMutation } = open()
    const name = screen.getByLabelText('Name of width')
    fireEvent.focus(name)
    // A variable's label is its reference name, so the doc layer silently drops
    // a rename that is not a valid identifier: the test names one that is, so
    // what it pins is a rename the app actually applies.
    fireEvent.change(name, { target: { value: 'plate_width' } })
    fireEvent.blur(name)
    expect(isValidVariableName('plate_width')).toBe(true)
    expect(onMutation).toHaveBeenCalledWith({ type: 'rename_feature', featureId: 'v1', label: 'plate_width' })

    const unit = screen.getByLabelText('Unit of width')
    onMutation.mockClear()
    fireEvent.focus(unit)
    fireEvent.change(unit, { target: { value: '' } })
    fireEvent.blur(unit)
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_variable_field', featureId: 'v1', field: 'unit', value: null })
  })

  it('writes a unit picked from the hint list immediately', () => {
    const { onMutation } = open()
    fireEvent.change(screen.getByLabelText('Unit hint of height'), { target: { value: 'deg' } })
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_variable_field', featureId: 'v2', field: 'unit', value: 'deg' })
  })

  it('abandons the draft when the document changes under the open field', () => {
    const { onMutation, onClose, onAdd, rerender } = open()
    const field = screen.getByLabelText('Expression of width') as HTMLInputElement
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: '30' } })
    expect(field.value).toBe('30')

    // The document changed under the open field (a solve landed, another view
    // edited the variable). The doc wins: the field shows the stored value and
    // the draft is abandoned rather than written over the new one.
    rerender(
      <ParameterTable
        isOpen
        rows={[{ ...rows[0], expression: '25' }, rows[1], rows[2]]}
        onClose={onClose}
        onMutation={onMutation}
        onAdd={onAdd}
      />,
    )
    expect((screen.getByLabelText('Expression of width') as HTMLInputElement).value).toBe('25')
    fireEvent.blur(field)
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('abandons the draft on Escape instead of committing it', () => {
    const { onMutation } = open()
    const field = screen.getByLabelText('Expression of width')
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: '99' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    fireEvent.blur(field)
    expect(onMutation).not.toHaveBeenCalled()
    expect((field as HTMLInputElement).value).toBe('20')
  })

  it('adds a parameter through the caller', () => {
    const { onAdd } = open()
    fireEvent.click(screen.getByRole('button', { name: 'Add parameter' }))
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  it('explains the empty state', () => {
    open({ rows: [] })
    expect(screen.getByText(/No parameters yet/)).toBeInTheDocument()
    // The add button stays available: an empty table is the invitation.
    expect(screen.getByRole('button', { name: 'Add parameter' })).toBeInTheDocument()
  })
})
