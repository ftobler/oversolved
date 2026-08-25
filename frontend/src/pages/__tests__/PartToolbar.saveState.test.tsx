// The saved check must reflect reality: it flashes only when the page's save
// resolves true, never while the request is in flight and never on a failure
// (the error banner reports failures; the toolbar just stays quiet).
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen, waitFor, act } from '@testing-library/react'
import PartToolbar from '@/pages/PartToolbar'

vi.mock('@/utils/core/commandRegistry', () => ({ executeCommand: vi.fn() }))
vi.mock('@/components/layout/AppHeader', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/adapters/backend', () => ({ backendBundle: { sharing: null } }))

function deferred() {
  let resolve!: (saved: boolean) => void
  const promise = new Promise<boolean>(r => { resolve = r })
  return { promise, resolve }
}

function renderToolbar(handleSave: () => Promise<boolean>) {
  return render(
    <PartToolbar
      readOnly={false}
      permission="owner"
      docName="TestDoc"
      isCloudDoc={false}
      onRename={vi.fn()}
      handleSave={handleSave}
      handleClone={vi.fn()}
      onShare={vi.fn()}
    />,
  )
}

const saveIcon = () => screen.getByRole('button', { name: 'Save' }).textContent

describe('PartToolbar save state', () => {
  it('flashes the check only after the save resolves true', async () => {
    const gate = deferred()
    renderToolbar(() => gate.promise)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    // In flight: still the plain save icon.
    expect(saveIcon()).toBe('save')

    await act(async () => { gate.resolve(true) })
    await waitFor(() => expect(saveIcon()).toBe('check'))
  })

  it('never shows the check when the save resolves false', async () => {
    const gate = deferred()
    renderToolbar(() => gate.promise)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await act(async () => { gate.resolve(false) })

    expect(saveIcon()).toBe('save')
  })

  it('a failed save after a successful one does not re-flash the check', async () => {
    const results: Promise<boolean>[] = [Promise.resolve(true), Promise.resolve(false)]
    renderToolbar(() => results.shift() ?? Promise.resolve(false))

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saveIcon()).toBe('check'))

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })

    expect(saveIcon()).toBe('save')
  })
})
