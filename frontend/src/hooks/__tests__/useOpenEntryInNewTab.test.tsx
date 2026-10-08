import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useOpenEntryInNewTab } from '@/hooks/useOpenEntryInNewTab'

function routerAt(basename?: string) {
  const prefix = (basename ?? '').replace(/\/$/, '')
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter basename={basename} initialEntries={[`${prefix}/workspaces/ws/entries/asm`]}>
      {children}
    </MemoryRouter>
  )
}

describe('useOpenEntryInNewTab', () => {
  afterEach(() => { vi.restoreAllMocks() })

  // A root-absolute `/workspaces/...` opened the host root under GitHub Pages
  // and got its 404. Vite hands the router its base with a trailing slash, so
  // both spellings must join into one clean URL.
  it.each(['/oversolved', '/oversolved/'])('opens the entry under basename %s', (basename) => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const { result } = renderHook(() => useOpenEntryInNewTab('ws'), { wrapper: routerAt(basename) })
    result.current('part-1')
    expect(open).toHaveBeenCalledWith('/oversolved/workspaces/ws/entries/part-1', '_blank')
  })

  it('opens the entry at the root when there is no basename', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const { result } = renderHook(() => useOpenEntryInNewTab('ws'), { wrapper: routerAt() })
    result.current('part-1')
    expect(open).toHaveBeenCalledWith('/workspaces/ws/entries/part-1', '_blank')
  })
})
