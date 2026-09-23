// The export path ends here: a Blob becomes a browser download through a
// throwaway object URL and anchor element. The function is pure side effects, so
// the test pins those side effects and the cleanup, not a return value.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { downloadBlob } from '../downloadBlob'

describe('downloadBlob', () => {
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL

  afterEach(() => {
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
    vi.restoreAllMocks()
  })

  it('anchors the blob under the filename, clicks it, then revokes and removes it', () => {
    const blob = new Blob(['payload'], { type: 'text/plain' })
    const createObjectURL = vi.fn(() => 'blob:download-1')
    const revokeObjectURL = vi.fn()
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL

    // jsdom does not implement object URLs, and its anchor is irrelevant to the
    // contract; the smallest anchor fake keeps the assertions on the fields the
    // browser actually reads.
    const click = vi.fn()
    const anchor = { href: '', download: '', click } as unknown as HTMLAnchorElement
    vi.spyOn(document, 'createElement').mockReturnValue(anchor)
    const append = vi.spyOn(document.body, 'appendChild').mockImplementation(node => node)
    const remove = vi.spyOn(document.body, 'removeChild').mockImplementation(node => node)

    downloadBlob(blob, 'part.step')

    expect(createObjectURL).toHaveBeenCalledWith(blob)
    expect(anchor.href).toBe('blob:download-1')
    expect(anchor.download).toBe('part.step')
    expect(append).toHaveBeenCalledWith(anchor)
    expect(click).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith(anchor)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:download-1')
  })
})
