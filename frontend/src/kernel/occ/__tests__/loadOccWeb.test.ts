// @vitest-environment jsdom
//
// loadOccWeb is the main-thread path to the OCCT artifact. It is deliberately
// failure-tolerant: any loader failure resolves to null so the kernel degrades
// to "local solver unavailable". The test-environment guard short-circuits
// before the module sets its cache, so each case reloads the module to start
// from a clean cache cell.
//
// The artifact is an ES module imported off a blob URL (importOccModule.ts);
// jsdom has no object URLs, so createObjectURL is pointed at a data URL holding
// the text the fetch stub returned. wasmCompile is mocked: the streaming and
// progress behaviour of compileOccWasm is covered by wasmCompile.test.ts, and
// here the focus is the loader's wiring (which URL is compiled, what the
// factory receives, how phases are reported).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

interface FakeWasmReport {
  download(loadedBytes: number, totalBytes: number): void
  compiling(): void
}

// vi.hoisted state survives vi.resetModules(): the reloaded loader re-imports
// the mock factory, but every generation closes over this same object.
const wasm = vi.hoisted(() => ({
  compiles: [] as Array<{ url: string; report: FakeWasmReport }>,
  onCompile: null as null | ((report: FakeWasmReport) => void),
  fail: false,
}))

vi.mock('../wasmCompile', () => ({
  compileOccWasm: async (url: string, report: FakeWasmReport) => {
    wasm.compiles.push({ url, report })
    wasm.onCompile?.(report)
    if (wasm.fail) throw new Error('wasm download failed')
    return { fake: 'module' }
  },
  makeInstantiateWasm: () => 'instantiate-hook',
}))

// resetModules gives a fresh loader (clean memo cell) and a fresh
// loadProgress instance; both are imported from the new registry so progress
// assertions read the store the loader actually writes.
async function freshLoadOccWeb() {
  vi.resetModules()
  const [progress, loader] = await Promise.all([
    import('../loadProgress'),
    import('../loadOccWeb'),
  ])
  progress.resetOccLoadProgress()
  return { loadOccWeb: loader.loadOccWeb, resetOccWeb: loader.resetOccWeb, progress }
}

// The factory records what it was handed on globalThis, since the module text
// runs in its own scope.
const FACTORY_JS =
  'export default async (opts) => { globalThis.__occOpts = opts; return { occt: "ready" } };'

function serve(js: string): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn(async () => ({ ok: true, text: async () => js }))
  vi.stubGlobal('fetch', fetchSpy)
  Object.assign(URL, {
    createObjectURL: vi.fn(() => `data:text/javascript,${encodeURIComponent(js)}`),
    revokeObjectURL: vi.fn(),
  })
  return fetchSpy
}

function factoryOpts(): { locateFile: (p: string) => string; instantiateWasm: unknown } {
  return (globalThis as unknown as { __occOpts: { locateFile: (p: string) => string; instantiateWasm: unknown } })
    .__occOpts
}

describe('loadOccWeb', () => {
  beforeEach(() => {
    vi.stubEnv('MODE', 'development')
    vi.stubEnv('DEV', true)
    wasm.compiles.length = 0
    wasm.onCompile = null
    wasm.fail = false
    delete (globalThis as unknown as { __occOpts?: unknown }).__occOpts
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('resolves null in the test environment without fetching', async () => {
    vi.stubEnv('MODE', 'test')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const { loadOccWeb } = await freshLoadOccWeb()
    expect(await loadOccWeb()).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('resolves null when the artifact fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { loadOccWeb } = await freshLoadOccWeb()
    expect(await loadOccWeb('/occ/')).toBeNull()
    expect(fetch).toHaveBeenCalledWith('/occ/occt.js')
    // Pinning the message (not just "error was called") keeps the !resp.ok
    // guard load-bearing: without it resp.text() would throw a TypeError and
    // the test would still see a logged error and a null result.
    expect(String((error.mock.calls[0][1] as Error).message)).toMatch(/HTTP 404/)
  })

  it('retries after a failed load instead of pinning the null result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const { loadOccWeb } = await freshLoadOccWeb()
    expect(await loadOccWeb('/occ/')).toBeNull()

    // The null result must be evicted, so a later call retries from scratch
    // rather than returning the cached null.
    const fetchSpy = serve(FACTORY_JS)
    expect(await loadOccWeb('/occ/')).toEqual({ occt: 'ready' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('resolves null when the module has no default factory', async () => {
    serve('export const notTheFactory = 1;')

    const { loadOccWeb, progress } = await freshLoadOccWeb()
    expect(await loadOccWeb('/occ/')).toBeNull()
    expect(progress.getOccLoadProgress().phase).toBe('failed')
    expect(wasm.compiles).toHaveLength(0)
  })

  it('compiles the wasm under the base and hands the compiled module to the factory', async () => {
    serve(FACTORY_JS)

    const { loadOccWeb } = await freshLoadOccWeb()
    expect(await loadOccWeb('/base/')).toEqual({ occt: 'ready' })

    expect(wasm.compiles).toHaveLength(1)
    expect(wasm.compiles[0].url).toBe('/base/occt.wasm')
    // The factory must not fetch the wasm itself: the compiled module travels
    // through the instantiateWasm hook (mocked to a sentinel here).
    expect(factoryOpts().instantiateWasm).toBe('instantiate-hook')
    expect(factoryOpts().locateFile('occt.wasm')).toBe('/base/occt.wasm')
    expect(factoryOpts().locateFile('worker.js')).toBe('worker.js')
  })

  it('reports the load through the progress phases', async () => {
    serve(FACTORY_JS)
    wasm.onCompile = (report) => {
      report.download(4, 8)
      report.compiling()
    }

    const { loadOccWeb, progress } = await freshLoadOccWeb()
    const seen: string[] = []
    const unsubscribe = progress.subscribeOccLoadProgress((p) => seen.push(p.phase))

    await loadOccWeb('/base/')
    unsubscribe()

    expect(seen[0]).toBe('downloading')
    expect(seen).toContain('compiling')
    expect(seen.at(-1)).toBe('ready')
    expect(progress.getOccLoadProgress()).toEqual({ phase: 'ready', loadedBytes: 4, totalBytes: 8 })
  })

  it('reports a failed compile and still resolves null', async () => {
    serve(FACTORY_JS)
    wasm.fail = true
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const { loadOccWeb, progress } = await freshLoadOccWeb()
    expect(await loadOccWeb('/base/')).toBeNull()
    expect(progress.getOccLoadProgress().phase).toBe('failed')
    expect(factoryOpts()).toBeUndefined()
  })

  it('memoizes the load: later calls return the first promise', async () => {
    const fetchSpy = serve(FACTORY_JS)

    const { loadOccWeb } = await freshLoadOccWeb()
    const first = loadOccWeb('/base/')
    const second = loadOccWeb('/other-base/')
    expect(second).toBe(first)
    await first
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('releases the occt.js blob URL only when the loader is reset', async () => {
    serve(FACTORY_JS)

    const { loadOccWeb, resetOccWeb } = await freshLoadOccWeb()
    expect(await loadOccWeb('/base/')).toEqual({ occt: 'ready' })
    // Kept while the module is live: something can still ask the URL again
    // after the import, and a revoked URL answers 404 (see importOccModule.ts).
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()

    resetOccWeb()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
  })
})
