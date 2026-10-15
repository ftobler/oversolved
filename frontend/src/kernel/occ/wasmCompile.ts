/**
 * Fetch and compile the OCC wasm with streaming compilation and download
 * progress.
 *
 * Emscripten's own loader would fetch the wasm and figure out streaming by
 * itself, but it reports nothing while the ~63 MB crosses the wire. Instead the
 * loaders compile the module here first (WebAssembly.compileStreaming, the
 * compile-only half of instantiateStreaming, so bytes go into the compiler
 * chunk by chunk instead of being buffered), then hand the compiled module to
 * the factory's `instantiateWasm` hook, where instantiation is synchronous
 * ([[makeInstantiateWasm]]). Every fallible step therefore runs inside the
 * loader's own try/catch, and a failed download rejects a promise instead of
 * hanging the emscripten runtime.
 *
 * The buffered fallback covers hosts that serve the .wasm with a wrong or
 * missing Content-Type: compileStreaming refuses non-wasm MIME types, so the
 * type is checked before consuming the body, and the bytes are read with the
 * same progress reporting and compiled with WebAssembly.compile.
 */

const WASM_CONTENT_TYPE = 'application/wasm'

export interface OccWasmReport {
  download(loadedBytes: number, totalBytes: number): void
  compiling(): void
}

function totalBytesOf(response: Response): number {
  return Number(response.headers.get('Content-Length') ?? 0)
}

/** Wrap the body so every chunk is counted before the compiler sees it. */
function streamingBody(response: Response, total: number, report: OccWasmReport): Response {
  const body = response.body
  if (!body) throw new Error('response has no readable body')
  const reader = body.getReader()
  let loaded = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        report.compiling()
        controller.close()
        return
      }
      loaded += value.byteLength
      report.download(loaded, total)
      controller.enqueue(value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
  return new Response(stream, { headers: { 'Content-Type': WASM_CONTENT_TYPE } })
}

// The buffer type is spelled out: TypeScript's typed arrays are generic over
// ArrayBufferLike, and WebAssembly.compile only accepts an ArrayBuffer-backed
// view.
async function readWithProgress(
  response: Response,
  total: number,
  report: OccWasmReport,
): Promise<Uint8Array<ArrayBuffer>> {
  const body = response.body
  if (!body) {
    const buffer = await response.arrayBuffer()
    report.download(buffer.byteLength, total)
    report.compiling()
    return new Uint8Array(buffer)
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.byteLength
    report.download(loaded, total)
  }
  const bytes = new Uint8Array(loaded)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  report.compiling()
  return bytes
}

export async function compileOccWasm(url: string, report: OccWasmReport): Promise<WebAssembly.Module> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`)
  const total = totalBytesOf(response)
  const contentType = (response.headers.get('Content-Type') ?? '').toLowerCase()
  const canStream =
    typeof WebAssembly.compileStreaming === 'function' &&
    response.body !== null &&
    contentType.startsWith(WASM_CONTENT_TYPE)

  if (canStream) {
    try {
      return await WebAssembly.compileStreaming(streamingBody(response, total, report))
    } catch (streamingError) {
      // The body the compiler consumed cannot be replayed, so a second fetch
      // is the honest recovery. Streaming only fails here on a truncated or
      // corrupt response; a MIME problem was excluded by the pre-check.
      const retry = await fetch(url)
      if (!retry.ok) throw streamingError
      return await WebAssembly.compile(await readWithProgress(retry, total, report))
    }
  }
  return await WebAssembly.compile(await readWithProgress(response, total, report))
}

/**
 * The factory config hook. The module is already compiled, so instantiation is
 * synchronous: `receive` gets the instance before the factory's init continues,
 * and the returned exports are the synchronous success path emscripten's
 * runtime understands.
 */
export function makeInstantiateWasm(
  module: WebAssembly.Module,
): (imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) => WebAssembly.Exports {
  return (imports, receive) => {
    const instance = new WebAssembly.Instance(module, imports)
    receive(instance)
    return instance.exports
  }
}
