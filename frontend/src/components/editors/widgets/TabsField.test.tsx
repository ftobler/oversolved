import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TabsField } from './TabsField'
import type { SelectFieldDef } from './fieldTypes'

const field: SelectFieldDef = {
  type: 'select', key: 'subject', label: 'Subject', default: 'body',
  presentation: 'tabs',
  options: [{ value: 'body', label: 'Body' }, { value: 'feature', label: 'Feature' }],
}

const baseProps = {
  field,
  fid: 'f1',
  value: 'body',
  data: { subject: 'body' },
  mutationType: 'set_test_field',
}

describe('TabsFieldWidget', () => {
  it('renders one tab per option', () => {
    render(<TabsField {...baseProps} onMutation={vi.fn()} />)
    expect(screen.getAllByRole('tab')).toHaveLength(2)
  })

  it('marks the active tab aria-selected', () => {
    render(<TabsField {...baseProps} onMutation={vi.fn()} />)
    expect(screen.getByRole('tab', { name: 'Body' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Feature' })).toHaveAttribute('aria-selected', 'false')
  })

  it('dispatches the same mutation on click', () => {
    const onMutation = vi.fn()
    render(<TabsField {...baseProps} onMutation={onMutation} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Feature' }))
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_test_field', featureId: 'f1', field: 'subject', value: 'feature' })
  })

  it('does not dispatch when clicking the active tab', () => {
    const onMutation = vi.fn()
    render(<TabsField {...baseProps} onMutation={onMutation} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Body' }))
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('moves and selects with arrow keys', () => {
    const onMutation = vi.fn()
    render(<TabsField {...baseProps} onMutation={onMutation} />)
    const body = screen.getByRole('tab', { name: 'Body' })
    body.focus()
    fireEvent.keyDown(body, { key: 'ArrowRight' })
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_test_field', featureId: 'f1', field: 'subject', value: 'feature' })
  })

  it('Home and End move and select', () => {
    const onMutation = vi.fn()
    const props = { ...baseProps, value: 'feature', data: { subject: 'feature' } }
    render(<TabsField {...props} onMutation={onMutation} />)
    const feature = screen.getByRole('tab', { name: 'Feature' })
    feature.focus()
    fireEvent.keyDown(feature, { key: 'Home' })
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_test_field', featureId: 'f1', field: 'subject', value: 'body' })
  })

  it('stops click and key events from bubbling', () => {
    const onClick = vi.fn()
    const onKeyDown = vi.fn()
    render(
      <div onClick={onClick} onKeyDown={onKeyDown}>
        <TabsField {...baseProps} onMutation={vi.fn()} />
      </div>,
    )
    const tab = screen.getByRole('tab', { name: 'Feature' })
    fireEvent.click(tab)
    fireEvent.keyDown(tab, { key: 'ArrowRight' })
    expect(onClick).not.toHaveBeenCalled()
    expect(onKeyDown).not.toHaveBeenCalled()
  })
})
