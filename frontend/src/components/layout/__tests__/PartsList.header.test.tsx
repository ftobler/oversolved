// Every card title has the same structure (a `<span>` in `.sidebar-header`),
// so the left-bound header rule treats all four alike. The assembly side is
// pinned in AssemblyTree.cards.test.tsx, which reads the same textContent.
import { describe, it, expect, beforeEach } from 'vitest'
import { renderSidebar, resetStores } from './sidebarTestHarness'

beforeEach(() => {
  resetStores()
})

describe('PartsList header', () => {
  it('wraps its title in a span like the other card headers', () => {
    const { container } = renderSidebar()
    const header = container.querySelector('.sidebar-bottom .sidebar-header') as HTMLElement
    expect(header).not.toBeNull()
    expect(header.children).toHaveLength(1)
    expect(header.firstElementChild!.tagName).toBe('SPAN')
    expect(header.textContent).toBe('Parts')
  })
})
