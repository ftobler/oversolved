import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useOpenEntryInNewTab } from '@/hooks/useOpenEntryInNewTab'

function routerAt(basename?: string) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter basename={basename} initialEntries={[`${basename ?? ''}/workspaces/ws/entries/asm`]}>
      {children}
    </MemoryRouter>
  )
}

describe('useOpenEntryInNewTab', () => {
  afterEach(() => { vi.restoreAllMocks() })

  // A new tab is a full page load, not a router navigation, so the URL must
  // carry the deploy base itself. A root-absolute `/workspaces/...` opened the
  // host root under GitHub Pages (`/oversolved/`) and got the host's 404.
  it('opens the entry under a non-root basename', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const { result } = renderHook(() => useOpenEntryInNewTab('ws'), { wrapper: routerAt('/oversolved') })
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
