// compileOccWasm is the step that turns the ~63 MB wasm into a compiled module
// with download progress. The tests drive fake Response bodies through it:
// streaming compile when the host serves application/wasm, buffered fallback
// when it does not or compileStreaming is unavailable, and a re-fetch fallback
// when the streamed compile fails. makeInstantiateWasm is exercised against a
// real (empty) module, since synchronous instantiation is the whole point.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { compileOccWasm, makeInstantiateWasm } from '../wasmCompile'

const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])

function fakeModule(): WebAssembly.Module {
  return new WebAssembly.Module(EMPTY_WASM)
}

function streamedResponse(chunks: Uint8Array[], headers: Record<string, string>): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(stream, { headers })
}

const encoder = new TextEncoder()

function report() {
  return { download: vi.fn(), compiling: vi.fn() }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('compileOccWasm', () => {
  it('streams with progress when the response is application/wasm', async () => {
    const bytes = [encoder.encode('abcd'), encoder.encode('efgh')]
    vi.stubGlobal('fetch', vi.fn(async () => streamedResponse(bytes, {
      'Content-Type': 'application/wasm',
      'Content-Length': '8',
    })))
    let seen: Response | null = null
    const compileStreaming = vi.spyOn(WebAssembly, 'compileStreaming').mockImplementation(async (source) => {
      seen = source as Response
      expect(new Uint8Array(await seen.arrayBuffer()).byteLength).toBe(8)
      return fakeModule()
    })

    const progress = report()
    const module = await compileOccWasm('/occ/opencascade.wasm.wasm', progress)

    expect(module).toBeInstanceOf(WebAssembly.Module)
    expect(compileStreaming).toHaveBeenCalledTimes(1)
    expect(seen!.headers.get('Content-Type')).toBe('application/wasm')
    expect(progress.download.mock.calls).toEqual([[4, 8], [8, 8]])
    expect(progress.compiling).toHaveBeenCalledTimes(1)
  })

  it('buffers and compiles when the host serves a wrong Content-Type', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamedResponse([encoder.encode('abcd')], {
      'Content-Type': 'application/octet-stream',
      'Content-Length': '4',
    })))
    const compileStreaming = vi.spyOn(WebAssembly, 'compileStreaming')
    const compile = vi.spyOn(WebAssembly, 'compile').mockImplementation(async () => fakeModule())

    const progress = report()
    const module = await compileOccWasm('/occ/opencascade.wasm.wasm', progress)

    expect(module).toBeInstanceOf(WebAssembly.Module)
    // The body was checked before it was consumed, so compileStreaming is never
    // handed a response it would reject.
    expect(compileStreaming).not.toHaveBeenCalled()
    expect(compile).toHaveBeenCalledTimes(1)
    // Array.from sidesteps the jsdom/Node realm split: the two Uint8Arrays
    // hold the same bytes but do not share a constructor.
    expect(Array.from(compile.mock.calls[0][0] as Uint8Array))
      .toEqual(Array.from(encoder.encode('abcd')))
    expect(progress.download.mock.calls).toEqual([[4, 4]])
    expect(progress.compiling).toHaveBeenCalledTimes(1)
  })

  it('buffers when compileStreaming does not exist', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamedResponse([encoder.encode('wasm')], {
      'Content-Type': 'application/wasm',
    })))
    const original = WebAssembly.compileStreaming
    delete (WebAssembly as { compileStreaming?: unknown }).compileStreaming
    try {
      const compile = vi.spyOn(WebAssembly, 'compile').mockImplementation(async () => fakeModule())
      const progress = report()
      const module = await compileOccWasm('/occ/opencascade.wasm.wasm', progress)
      expect(module).toBeInstanceOf(WebAssembly.Module)
      expect(compile).toHaveBeenCalledTimes(1)
      // No Content-Length: the counter still advances, the total stays 0.
      expect(progress.download.mock.calls).toEqual([[4, 0]])
    } finally {
      Object.defineProperty(WebAssembly, 'compileStreaming', {
        value: original,
        writable: true,
        configurable: true,
        enumerable: true,
      })
    }
  })

  it('re-fetches and buffers when the streamed compile fails', async () => {
    const fetchSpy = vi.fn(async () => streamedResponse([encoder.encode('bad!')], {
      'Content-Type': 'application/wasm',
    }))
    vi.stubGlobal('fetch', fetchSpy)
    vi.spyOn(WebAssembly, 'compileStreaming').mockRejectedValue(new TypeError('stream truncated'))
    const compile = vi.spyOn(WebAssembly, 'compile').mockImplementation(async () => fakeModule())

    const progress = report()
    const module = await compileOccWasm('/occ/opencascade.wasm.wasm', progress)

    expect(module).toBeInstanceOf(WebAssembly.Module)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(compile).toHaveBeenCalledTimes(1)
  })

  it('rejects on a non-ok response without touching the compiler', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 } as Response)))
    const compile = vi.spyOn(WebAssembly, 'compile')

    await expect(compileOccWasm('/occ/opencascade.wasm.wasm', report())).rejects.toThrow('HTTP 404')
    expect(compile).not.toHaveBeenCalled()
  })
})

describe('makeInstantiateWasm', () => {
  // (module (import "env" "f" (func))): instantiating it needs the import,
  // which proves the hook forwards its `imports` argument.
  const IMPORTING_WASM = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    1, 4, 1, 96, 0, 0,
    2, 9, 1, 3, 101, 110, 118, 1, 102, 0, 0,
  ])

  it('instantiates synchronously, hands the instance to receive, and returns its exports', () => {
    const module = fakeModule()
    const receive = vi.fn()

    const exports = makeInstantiateWasm(module)({}, receive)

    expect(receive).toHaveBeenCalledTimes(1)
    expect(receive.mock.calls[0][0]).toBeInstanceOf(WebAssembly.Instance)
    expect(exports).toBe((receive.mock.calls[0][0] as WebAssembly.Instance).exports)
  })

  it('forwards the imports to the synchronous instantiation', () => {
    const module = new WebAssembly.Module(IMPORTING_WASM)
    expect(() => makeInstantiateWasm(module)({}, () => {})).toThrow()
    expect(() => makeInstantiateWasm(module)({ env: { f: () => {} } }, () => {})).not.toThrow()
  })
})
