/**
 * Route the kernel's stdout writes to stderr for the node entries.
 *
 * OCC's STEP writer prints its transfer banner to stdout (Emscripten's
 * Module.print goes through console.log), and both entries reserve stdout as a
 * machine channel: the CLI prints one JSON object per command, the MCP server
 * JSON-RPC lines. The returned writer is the real stdout, for the caller's own
 * protocol output; every other stdout write (console.log included) goes to
 * stderr.
 */

function toStderr(buffer: Uint8Array | string, cb?: (err?: Error | null) => void): boolean
function toStderr(str: Uint8Array | string, encoding?: BufferEncoding, cb?: (err?: Error | null) => void): boolean
function toStderr(
  chunk: Uint8Array | string,
  encoding?: BufferEncoding | ((err?: Error | null) => void),
  cb?: (err?: Error | null) => void,
): boolean {
  if (typeof encoding === 'function') return process.stderr.write(chunk, encoding)
  return process.stderr.write(chunk, encoding, cb)
}

export function routeKernelStdoutToStderr(): typeof process.stdout.write {
  const writeStdout = process.stdout.write.bind(process.stdout)
  process.stdout.write = toStderr
  console.log = (...args: unknown[]) => { console.error(...args) }
  return writeStdout
}
