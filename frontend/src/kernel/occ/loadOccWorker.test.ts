// loadOccWorker is the DOM-free OCC loader the solver Worker installs. It
// fetches the ES-module artifact, imports it off a blob URL (no script tag, no
// export stripping), and calls its default factory. Any failure -- a bad HTTP
// response, a module without the factory, a factory throw -- resolves to null
// so the caller reports "local solver unavailable" rather than crashing.
import { describe, it, expect, vi, afterEach } from 'vitest'

async function freshLoadOccWorker() {
  vi.resetModules()
  return (await import('./loadOccWorker')).loadOccWorker
}

// jsdom does not implement object URLs; point createObjectURL at a data URL so
// the module import resolves to the text the fetch stub returned.
function stubObjectUrl(dataUrl: string) {
  Object.assign(URL, {
    createObjectURL: vi.fn(() => dataUrl),
    revokeObjectURL: vi.fn(),
  })
}

describe('loadOccWorker', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('resolves null when the artifact fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const loadOccWorker = await freshLoadOccWorker()
    expect(await loadOccWorker('/occ/')).toBeNull()
    // Pin the HTTP message so the !resp.ok guard stays load-bearing; otherwise
    // the missing text() would throw and log a different error just the same.
    expect(String((error.mock.calls[0][1] as Error).message)).toMatch(/HTTP 500/)
  })

  it('resolves null when the imported module has no default factory', async () => {
    const js = 'export const notTheFactory = 1;'
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => js })))
    stubObjectUrl(`data:text/javascript,${encodeURIComponent(js)}`)

    const loadOccWorker = await freshLoadOccWorker()
    expect(await loadOccWorker()).toBeNull()
  })

  it('calls the imported factory and resolves its module', async () => {
    const js = 'export default async () => ({ occt: "ready" });'
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => js })))
    stubObjectUrl(`data:text/javascript,${encodeURIComponent(js)}`)

    const loadOccWorker = await freshLoadOccWorker()
    expect(await loadOccWorker('/occ/')).toEqual({ occt: 'ready' })
  })

  it('retries after a failed load instead of pinning the null', async () => {
    const js = 'export default async () => ({ occt: "ready" });'
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, text: async () => js })
    vi.stubGlobal('fetch', fetchSpy)
    stubObjectUrl(`data:text/javascript,${encodeURIComponent(js)}`)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const loadOccWorker = await freshLoadOccWorker()
    expect(await loadOccWorker('/occ/')).toBeNull()
    // The failed (null) load was evicted, so the retry runs the loader again and
    // installs the now-available module instead of returning the pinned null.
    expect(await loadOccWorker('/occ/')).toEqual({ occt: 'ready' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
