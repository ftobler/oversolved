// loadOccWeb is the main-thread path to the opencascade.js artifact. It is
// deliberately failure-tolerant: any loader failure resolves to null so the
// kernel degrades to "local solver unavailable". The test-environment guard
// short-circuits before the module sets its cache, so each case reloads the
// module to start from a clean cache cell.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

async function freshLoadOccWeb() {
  vi.resetModules()
  return (await import('./loadOccWeb')).loadOccWeb
}

describe('loadOccWeb', () => {
  beforeEach(() => {
    vi.stubEnv('MODE', 'development')
    vi.stubEnv('DEV', true)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete (window as unknown as { opencascade?: unknown }).opencascade
  })

  it('resolves null in the test environment without fetching', async () => {
    vi.stubEnv('MODE', 'test')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const loadOccWeb = await freshLoadOccWeb()
    expect(await loadOccWeb()).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('resolves null when the artifact fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const loadOccWeb = await freshLoadOccWeb()
    expect(await loadOccWeb('/occ/')).toBeNull()
    expect(fetch).toHaveBeenCalledWith('/occ/opencascade.wasm.js')
    // Pinning the message (not just "error was called") keeps the !resp.ok
    // guard load-bearing: without it resp.text() would throw a TypeError and
    // the test would still see a logged error and a null result.
    expect(String((error.mock.calls[0][1] as Error).message)).toMatch(/HTTP 404/)
  })

  it('reuses a factory already attached to window and maps the wasm locateFile', async () => {
    const factory = vi.fn(async (_opts: { locateFile: (p: string) => string }) => ({ occt: 'ready' }))
    ;(window as unknown as { opencascade?: unknown }).opencascade = factory

    const loadOccWeb = await freshLoadOccWeb()
    expect(await loadOccWeb('/base/')).toEqual({ occt: 'ready' })

    const { locateFile } = factory.mock.calls[0][0]
    expect(locateFile('opencascade.wasm')).toBe('/base/opencascade.wasm.wasm')
    expect(locateFile('worker.js')).toBe('worker.js')
  })

  it('memoizes the load: later calls return the first promise', async () => {
    const factory = vi.fn(async (_opts: { locateFile: (p: string) => string }) => ({ occt: 'ready' }))
    ;(window as unknown as { opencascade?: unknown }).opencascade = factory

    const loadOccWeb = await freshLoadOccWeb()
    const first = loadOccWeb('/base/')
    const second = loadOccWeb('/other-base/')
    expect(second).toBe(first)
    await first
    expect(factory).toHaveBeenCalledTimes(1)
  })
})
