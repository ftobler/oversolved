import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PickChip } from '../PickChip'

describe('PickChip', () => {
  it('renders empty state without text when no emptyText provided', () => {
    render(
      <PickChip
        values={[]}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    const chip = document.querySelector('.feature-pick-chip')
    expect(chip).toBeTruthy()
    expect(chip?.classList.contains('empty')).toBe(true)
    expect(chip?.textContent).toBe('')
  })

  it('renders empty text when provided and empty', () => {
    render(
      <PickChip
        values={[]}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
        emptyText="(pick target)"
      />
    )
    expect(screen.getByText('(pick target)')).toBeInTheDocument()
  })

  it('renders single value', () => {
    render(
      <PickChip
        values={['@sk1']}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    expect(screen.getByText('@sk1')).toBeInTheDocument()
    const chip = document.querySelector('.feature-pick-chip')
    expect(chip?.classList.contains('empty')).toBe(false)
  })

  it('renders multiple values', () => {
    render(
      <PickChip
        values={['@sk1', '@sk2', '@sk3']}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    expect(screen.getByText('@sk1')).toBeInTheDocument()
    expect(screen.getByText('@sk2')).toBeInTheDocument()
    expect(screen.getByText('@sk3')).toBeInTheDocument()
    const items = document.querySelectorAll('.feature-pick-chip-item')
    expect(items.length).toBe(3)
  })

  it('applies picking class when isPicking is true', () => {
    render(
      <PickChip
        values={[]}
        isPicking={true}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    const chip = document.querySelector('.feature-pick-chip')
    expect(chip?.classList.contains('picking')).toBe(true)
  })

  it('calls onActivate when clicked', () => {
    const onActivate = vi.fn()
    render(
      <PickChip
        values={['@sk1']}
        isPicking={false}
        onActivate={onActivate}
        onRemove={vi.fn()}
      />
    )
    const chip = document.querySelector('.feature-pick-chip')!
    fireEvent.click(chip)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('calls onRemove with correct index when remove button clicked', () => {
    const onRemove = vi.fn()
    render(
      <PickChip
        values={['@sk1', '@sk2', '@sk3']}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={onRemove}
      />
    )
    const removeButtons = document.querySelectorAll('.feature-pick-chip-item-remove')
    expect(removeButtons.length).toBe(3)
    fireEvent.click(removeButtons[1])
    expect(onRemove).toHaveBeenCalledWith(1)
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('does not call onActivate when remove button clicked (stopPropagation)', () => {
    const onActivate = vi.fn()
    const onRemove = vi.fn()
    render(
      <PickChip
        values={['@sk1']}
        isPicking={false}
        onActivate={onActivate}
        onRemove={onRemove}
      />
    )
    const removeButton = document.querySelector('.feature-pick-chip-item-remove')!
    fireEvent.click(removeButton)
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('renders many values without error', () => {
    render(
      <PickChip
        values={['a', 'b', 'c', 'd', 'e']}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    const items = document.querySelectorAll('.feature-pick-chip-item')
    expect(items.length).toBe(5)
  })

  it('renders drag handle for each item when onReorder is provided', () => {
    render(
      <PickChip
        values={['@sk1', '@sk2', '@sk3']}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
        onReorder={vi.fn()}
      />
    )
    const dragHandles = document.querySelectorAll('.feature-pick-chip-item-drag')
    expect(dragHandles.length).toBe(3)
  })

  it('does not render drag handles when onReorder is not provided', () => {
    render(
      <PickChip
        values={['@sk1', '@sk2', '@sk3']}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    const dragHandles = document.querySelectorAll('.feature-pick-chip-item-drag')
    expect(dragHandles.length).toBe(0)
  })

  it('items have draggable attribute when onReorder is provided', () => {
    render(
      <PickChip
        values={['@sk1', '@sk2']}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
        onReorder={vi.fn()}
      />
    )
    const items = document.querySelectorAll('.feature-pick-chip-item')
    expect(items[0].getAttribute('draggable')).toBe('true')
    expect(items[1].getAttribute('draggable')).toBe('true')
  })

  it('items are not draggable when onReorder is not provided', () => {
    render(
      <PickChip
        values={['@sk1', '@sk2']}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    const items = document.querySelectorAll('.feature-pick-chip-item')
    expect(items[0].getAttribute('draggable')).toBe('false')
    expect(items[1].getAttribute('draggable')).toBe('false')
  })

  it('drag handle has correct class for styling', () => {
    render(
      <PickChip
        values={['@sk1']}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
        onReorder={vi.fn()}
      />
    )
    const dragHandle = document.querySelector('.feature-pick-chip-item-drag')
    expect(dragHandle).toBeTruthy()
  })

  it('calls onReorder with correct indices after drag simulation', () => {
    const onReorder = vi.fn()
    render(
      <PickChip
        values={['@sk1', '@sk2', '@sk3']}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
        onReorder={onReorder}
      />
    )
    const items = document.querySelectorAll('.feature-pick-chip-item')
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', getData: vi.fn(() => '2'), dropEffect: '' }
    fireEvent.dragStart(items[2], { dataTransfer })
    fireEvent.dragOver(items[0], { dataTransfer })
    fireEvent.drop(items[0], { dataTransfer })
    expect(onReorder).toHaveBeenCalledTimes(1)
    expect(onReorder).toHaveBeenCalledWith(2, expect.any(Number))
  })

  it('does not call onReorder when dragged onto itself', () => {
    const onReorder = vi.fn()
    render(
      <PickChip
        values={['@sk1', '@sk2', '@sk3']}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
        onReorder={onReorder}
      />
    )
    const items = document.querySelectorAll('.feature-pick-chip-item')
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', getData: vi.fn(() => '1'), dropEffect: '' }
    fireEvent.dragStart(items[1], { dataTransfer })
    fireEvent.dragOver(items[1], { dataTransfer, clientX: 0 })
    fireEvent.drop(items[1], { dataTransfer })
    expect(onReorder).not.toHaveBeenCalled()
  })
})
