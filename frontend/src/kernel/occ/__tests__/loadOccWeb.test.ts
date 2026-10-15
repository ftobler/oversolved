// loadOccWeb is the main-thread path to the opencascade.js artifact. It is
// deliberately failure-tolerant: any loader failure resolves to null so the
// kernel degrades to "local solver unavailable". The test-environment guard
// short-circuits before the module sets its cache, so each case reloads the
// module to start from a clean cache cell.
//
// wasmCompile is mocked: the streaming/progress behaviour of compileOccWasm is
// covered by wasmCompile.test.ts, and here the focus is the loader's wiring
// (which URL is compiled, what the factory receives, how phases are reported).
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
  return { loadOccWeb: loader.loadOccWeb, progress }
}

describe('loadOccWeb', () => {
  beforeEach(() => {
    vi.stubEnv('MODE', 'development')
    vi.stubEnv('DEV', true)
    wasm.compiles.length = 0
    wasm.onCompile = null
    wasm.fail = false
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

    const { loadOccWeb } = await freshLoadOccWeb()
    expect(await loadOccWeb()).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('resolves null when the artifact fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { loadOccWeb } = await freshLoadOccWeb()
    expect(await loadOccWeb('/occ/')).toBeNull()
    expect(fetch).toHaveBeenCalledWith('/occ/opencascade.wasm.js')
    // Pinning the message (not just "error was called") keeps the !resp.ok
    // guard load-bearing: without it resp.text() would throw a TypeError and
    // the test would still see a logged error and a null result.
    expect(String((error.mock.calls[0][1] as Error).message)).toMatch(/HTTP 404/)
  })

  it('retries after a failed load instead of pinning the null result', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 404 }))
    vi.stubGlobal('fetch', fetchSpy)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const { loadOccWeb } = await freshLoadOccWeb()
    // First call fails (no window.opencascade, the fetch 404s) and resolves null.
    expect(await loadOccWeb('/occ/')).toBeNull()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // The null result must be evicted, so a later call retries from scratch
    // rather than returning the cached null. Attach a factory and confirm the
    // second call reaches it.
    const factory = vi.fn(async () => ({ occt: 'ready' }))
    ;(window as unknown as { opencascade?: unknown }).opencascade = factory
    expect(await loadOccWeb('/occ/')).toEqual({ occt: 'ready' })
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('reuses a factory already attached to window and maps the wasm locateFile', async () => {
    const factory = vi.fn(async (_opts: { locateFile: (p: string) => string }) => ({ occt: 'ready' }))
    ;(window as unknown as { opencascade?: unknown }).opencascade = factory

    const { loadOccWeb } = await freshLoadOccWeb()
    expect(await loadOccWeb('/base/')).toEqual({ occt: 'ready' })

    const { locateFile } = factory.mock.calls[0][0]
    expect(locateFile('opencascade.wasm')).toBe('/base/opencascade.wasm.wasm')
    expect(locateFile('worker.js')).toBe('worker.js')
  })

  it('compiles the wasm under the base and hands the compiled module to the factory', async () => {
    const factory = vi.fn(async (_opts: unknown) => ({ occt: 'ready' }))
    ;(window as unknown as { opencascade?: unknown }).opencascade = factory

    const { loadOccWeb } = await freshLoadOccWeb()
    await loadOccWeb('/base/')

    expect(wasm.compiles).toHaveLength(1)
    expect(wasm.compiles[0].url).toBe('/base/opencascade.wasm.wasm')
    // The factory must not fetch the wasm itself: the compiled module travels
    // through the instantiateWasm hook (mocked to a sentinel here).
    expect(factory.mock.calls[0][0]).toMatchObject({ instantiateWasm: 'instantiate-hook' })
  })

  it('reports the load through the progress phases', async () => {
    const factory = vi.fn(async (_opts: unknown) => ({ occt: 'ready' }))
    ;(window as unknown as { opencascade?: unknown }).opencascade = factory
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
    const factory = vi.fn(async (_opts: unknown) => ({ occt: 'ready' }))
    ;(window as unknown as { opencascade?: unknown }).opencascade = factory
    wasm.fail = true
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const { loadOccWeb, progress } = await freshLoadOccWeb()
    expect(await loadOccWeb('/base/')).toBeNull()
    expect(progress.getOccLoadProgress().phase).toBe('failed')
    expect(factory).not.toHaveBeenCalled()
  })

  it('memoizes the load: later calls return the first promise', async () => {
    const factory = vi.fn(async (_opts: { locateFile: (p: string) => string }) => ({ occt: 'ready' }))
    ;(window as unknown as { opencascade?: unknown }).opencascade = factory

    const { loadOccWeb } = await freshLoadOccWeb()
    const first = loadOccWeb('/base/')
    const second = loadOccWeb('/other-base/')
    expect(second).toBe(first)
    await first
    expect(factory).toHaveBeenCalledTimes(1)
  })

  // The script-injection path. jsdom does not execute an injected blob script,
  // so the load/error events are driven by a fake <script> whose appendChild
  // fires them. URL.createObjectURL is absent in jsdom, hence the stub.
  function stubScriptInjection(behavior: 'load' | 'error' | 'silent'): {
    script: { onload?: () => void; onerror?: () => void; src: string }
    createObjectURL: ReturnType<typeof vi.fn>
    revokeObjectURL: ReturnType<typeof vi.fn>
    blobText: () => string
  } {
    const script: { onload?: () => void; onerror?: () => void; src: string } = { src: '' }
    const createObjectURL = vi.fn(() => 'blob:occ')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    let captured = ''
    const RealBlob = Blob
    vi.stubGlobal('Blob', class extends RealBlob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options)
        captured = (parts ?? []).map((p) => String(p)).join('')
      }
    })
    vi.spyOn(document, 'createElement').mockReturnValue(script as unknown as HTMLElement)
    vi.spyOn(document.head, 'appendChild').mockImplementation((node: Node) => {
      if (behavior !== 'silent') {
        queueMicrotask(() => {
          if (behavior === 'error') script.onerror?.()
          else script.onload?.()
        })
      }
      return node
    })
    return { script, createObjectURL, revokeObjectURL, blobText: () => captured }
  }

  it('injects a classic script, strips the ES export, and calls the factory', async () => {
    const factory = vi.fn(async (_opts: { locateFile: (p: string) => string }) => ({ occt: 'ready' }))
    const source = 'var opencascade = function() {};\nexport default opencascade;\n'
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => source })))
    const { script, createObjectURL, revokeObjectURL, blobText } = stubScriptInjection('load')

    const { loadOccWeb } = await freshLoadOccWeb()
    const promise = loadOccWeb('/base/')
    ;(window as unknown as { opencascade?: unknown }).opencascade = factory
    // The injection runs a microtask before the load event; let both settle.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await promise).toEqual({ occt: 'ready' })

    // The blob must not carry `export default`, a syntax error in a classic
    // <script>, and its URL must be revoked once the script has loaded.
    expect(blobText()).not.toContain('export default')
    expect(script.src).toBe('blob:occ')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:occ')

    const { locateFile } = factory.mock.calls[0][0]
    expect(locateFile('opencascade.wasm')).toBe('/base/opencascade.wasm.wasm')
    expect(locateFile('worker.js')).toBe('worker.js')
  })

  it('resolves null when the injected script fires onerror', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => 'x' })))
    stubScriptInjection('error')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { loadOccWeb } = await freshLoadOccWeb()
    expect(await loadOccWeb('/occ/')).toBeNull()
    // The onerror handler logs dev-only with one arg; the outer catch logs the
    // rejection, whose message is what must reach the caller as null.
    const outer = error.mock.calls.find((c) => c[1] instanceof Error)
    expect(String((outer?.[1] as Error).message)).toMatch(/failed to load/)
  })

  it('resolves null when the script loads but never defines window.opencascade', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => 'x' })))
    stubScriptInjection('load')

    const { loadOccWeb } = await freshLoadOccWeb()
    expect(await loadOccWeb('/occ/')).toBeNull()
  })

  it('resolves null when the injected script never loads', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => 'x' })))
    stubScriptInjection('silent')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const { loadOccWeb } = await freshLoadOccWeb()
    const promise = loadOccWeb('/occ/')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await promise).toBeNull()
  })
})
