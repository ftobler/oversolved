// The parameter table dialog: it renders one row per variable, commits an
// edited cell on blur (never per keystroke), abandons the draft on Escape, and
// appends a parameter through the caller's own mutation. Every write leaves as
// the cell's mutation, so the dialog holds no document knowledge of its own.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ParameterTable from '@/pages/ParameterTable'
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
    fireEvent.change(name, { target: { value: 'plate width' } })
    fireEvent.blur(name)
    expect(onMutation).toHaveBeenCalledWith({ type: 'rename_feature', featureId: 'v1', label: 'plate width' })

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
