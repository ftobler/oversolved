import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RightClickMenu from '@/components/dialogs/RightClickMenu'

// The menu is used for the library's import door, so it has to work without a
// mouse: focus moves in on open, the arrows walk and wrap, Escape closes, and a
// pick hands focus back to whatever opened it.

function items(onOne: () => void = () => {}, onTwo: () => void = () => {}) {
  return [
    { label: 'One', onClick: onOne },
    { label: 'Two', onClick: onTwo },
  ]
}

describe('RightClickMenu keyboard', () => {
  it('focuses the first item on open and wraps with the arrow keys', () => {
    render(<RightClickMenu items={items()} position={[0, 0]} onClose={() => {}} />)
    const one = screen.getByRole('menuitem', { name: 'One' })
    const two = screen.getByRole('menuitem', { name: 'Two' })

    expect(one).toHaveFocus()
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(two).toHaveFocus()
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(one).toHaveFocus()
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    expect(two).toHaveFocus()
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<RightClickMenu items={items()} position={[0, 0]} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('activates the focused item with Enter', async () => {
    const onPick = vi.fn()
    const onClose = vi.fn()
    render(<RightClickMenu items={[{ label: 'Pick', onClick: onPick }]} position={[0, 0]} onClose={onClose} />)

    await userEvent.keyboard('{Enter}')

    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('returns focus to the opener on close', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()

    const { unmount } = render(<RightClickMenu items={items()} position={[0, 0]} onClose={() => {}} />)
    unmount()

    expect(opener).toHaveFocus()
    opener.remove()
  })
})
