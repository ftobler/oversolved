import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, fireEvent, act } from '@testing-library/react'
import { installPointerEventStub } from '@/testing/pointerEventStub'
import { freshLocalDb, renderWorkspaces, seedStore } from './workspacesHarness'

// jsdom has no PointerEvent; without the stub fireEvent drops button, id and type.
installPointerEventStub('mouse')

// The browser's order selector and pointer gestures run against the real store:
// a fake store would let a page-side-only reorder pass while nothing persisted.
describe('Workspaces custom order', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    freshLocalDb()
    localStorage.clear()
    window.history.pushState({}, '', '/')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function seed(names: string[]): Promise<string[]> {
    const store = seedStore()
    const ids: string[] = []
    for (const name of names) ids.push((await store.create(name)).workspace)
    return ids
  }

  // Three 100x80 columns with a 20px gutter. The rects come from the tiles'
  // original positions, so a live reflow cannot move the drop slot under us.
  function stubGrid(ids: string[]) {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const id = (this as HTMLElement).dataset.workspace
      const index = ids.indexOf(id ?? '')
      const left = index < 0 ? 0 : (index % 3) * 120
      const top = index < 0 ? 0 : Math.floor(index / 3) * 100
      return {
        left, top, width: 100, height: 80, right: left + 100, bottom: top + 80,
        x: left, y: top, toJSON: () => ({}),
      } as DOMRect
    })
  }

  const tile = (name: string) => screen.getByText(name, { selector: '.doc-tile-name' }).closest('.doc-tile') as HTMLElement
  const visibleNames = () => Array.from(document.querySelectorAll('.doc-tile .doc-tile-name')).map(el => el.textContent)
  const press = (el: HTMLElement, x: number, y: number, pointerType = 'mouse') => fireEvent.pointerDown(el, {
    bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerId: 1, pointerType, clientX: x, clientY: y,
  })
  const move = (x: number, y: number) => fireEvent.pointerMove(window, { pointerId: 1, clientX: x, clientY: y })
  const release = (x: number, y: number) => fireEvent.pointerUp(window, { pointerId: 1, clientX: x, clientY: y })
  const choose = (label: 'Date' | 'Custom') => fireEvent.click(screen.getByRole('button', { name: label }))

  it('defaults to Date and remembers Custom across a remount', async () => {
    await seed(['Alpha'])
    const first = renderWorkspaces()
    await waitFor(() => expect(tile('Alpha')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Date' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'false')

    choose('Custom')
    expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true')
    expect(JSON.parse(localStorage.getItem('oversolved.preferences')!)).toMatchObject({ workspace_sort: 'custom' })

    first.unmount()
    renderWorkspaces()
    await waitFor(() => expect(tile('Alpha')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('drags the third tile before the first, reflowing live and committing once', async () => {
    const [a, b, c] = await seed(['A', 'B', 'C'])
    stubGrid([a, b, c])
    const store = seedStore()
    const moveSpy = vi.spyOn(store, 'moveWorkspace')
    renderWorkspaces()
    await waitFor(() => expect(tile('C')).toBeTruthy())
    choose('Custom')
    await waitFor(() => expect(visibleNames()).toEqual(['A', 'B', 'C']))

    expect(tile('C')).toHaveClass('draggable')
    press(tile('C'), 290, 40)
    move(300, 44)
    expect(document.querySelector('.doc-tile.dragging')).toBeTruthy()
    move(10, 40)
    expect(visibleNames()).toEqual(['C', 'A', 'B'])
    release(10, 40)

    await waitFor(() => expect(moveSpy).toHaveBeenCalledTimes(1))
    expect(moveSpy).toHaveBeenCalledWith(c, 0)
    await waitFor(() => expect(visibleNames()).toEqual(['C', 'A', 'B']))
    expect(document.querySelector('.doc-tile.dragging')).toBeNull()
  })

  it('leaves tiles not draggable in Date, during search and in the trash', async () => {
    const [a, b] = await seed(['Alpha', 'Beta'])
    stubGrid([a, b])
    const store = seedStore()
    const moveSpy = vi.spyOn(store, 'moveWorkspace')
    renderWorkspaces()
    await waitFor(() => expect(tile('Alpha')).toBeTruthy())
    expect(tile('Alpha')).not.toHaveClass('draggable')

    choose('Custom')
    expect(tile('Alpha')).toHaveClass('draggable')
    fireEvent.change(screen.getByPlaceholderText('Search workspaces...'), { target: { value: 'alpha' } })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await act(async () => { vi.advanceTimersByTime(300) })
    expect(screen.getByText(/Drag is off while searching/)).toBeTruthy()
    expect(tile('Alpha')).not.toHaveClass('draggable')
    vi.useRealTimers()

    fireEvent.click(screen.getByTitle('Clear search'))
    await waitFor(() => expect(tile('Alpha')).toHaveClass('draggable'))
    await store.trash(a)
    fireEvent.click(screen.getByText('Trash'))
    await waitFor(() => expect(tile('Alpha')).toBeTruthy())
    expect(tile('Alpha')).not.toHaveClass('draggable')

    press(tile('Alpha'), 50, 40)
    move(10, 40)
    release(10, 40)
    expect(moveSpy).not.toHaveBeenCalled()
  })

  it('still opens a workspace when the tile is clicked without movement', async () => {
    const [a, b] = await seed(['Alpha', 'Beta'])
    stubGrid([a, b])
    renderWorkspaces()
    await waitFor(() => expect(tile('Alpha')).toBeTruthy())
    choose('Custom')

    press(tile('Alpha'), 50, 40)
    release(50, 40)
    fireEvent.click(tile('Alpha').querySelector('.doc-tile-link')!)

    await waitFor(() => expect(window.location.pathname).toBe(`/workspaces/${a}`))
    expect(document.querySelector('.doc-tile.dragging')).toBeNull()
  })

  it('starts a touch drag on a long press, not on a quick swipe', async () => {
    const [a, b, c] = await seed(['A', 'B', 'C'])
    stubGrid([a, b, c])
    const moveSpy = vi.spyOn(seedStore(), 'moveWorkspace')
    renderWorkspaces()
    await waitFor(() => expect(tile('C')).toBeTruthy())
    choose('Custom')
    await waitFor(() => expect(visibleNames()).toEqual(['A', 'B', 'C']))

    press(tile('C'), 290, 40, 'touch')
    move(300, 44)
    expect(document.querySelector('.doc-tile.dragging')).toBeNull()
    release(300, 44)
    expect(moveSpy).not.toHaveBeenCalled()

    press(tile('C'), 290, 40, 'touch')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 380)) })
    expect(document.querySelector('.doc-tile.dragging')).toBeTruthy()
    move(10, 40)
    release(10, 40)

    await waitFor(() => expect(moveSpy).toHaveBeenCalledWith(c, 0))
  })

  it('Escape cancels a drag without calling moveWorkspace', async () => {
    const [a, b, c] = await seed(['A', 'B', 'C'])
    stubGrid([a, b, c])
    const moveSpy = vi.spyOn(seedStore(), 'moveWorkspace')
    renderWorkspaces()
    await waitFor(() => expect(tile('C')).toBeTruthy())
    choose('Custom')
    await waitFor(() => expect(visibleNames()).toEqual(['A', 'B', 'C']))

    press(tile('C'), 290, 40)
    move(10, 40)
    expect(visibleNames()).toEqual(['C', 'A', 'B'])
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(visibleNames()).toEqual(['A', 'B', 'C'])
    release(10, 40)
    expect(moveSpy).not.toHaveBeenCalled()
  })
})
