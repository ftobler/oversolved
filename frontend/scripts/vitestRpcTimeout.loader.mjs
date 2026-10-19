// Vitest 3 builds the worker's RPC client with birpc's hard-coded 60 s call
// timeout. A loaded CI host can answer an `onTaskUpdate` past that deadline and
// fail an otherwise green run (`Timeout calling "onTaskUpdate"`). Vitest 4
// removes the deadline; for 3.x this preload doubles it in the worker only.
//
// The chunk name is content-hashed, so match the constant inside a vitest dist
// module rather than a file name. The test in
// src/__tests__/vitestRpcTimeout.test.ts pins this against the installed bundle.
const BUNDLED_TIMEOUT = 'const DEFAULT_TIMEOUT = 6e4;'
const WIDENED_TIMEOUT = 'const DEFAULT_TIMEOUT = 1.2e5;'

// One hook serves both registration APIs: the async `register()` calls
// nextLoad and gets a promise, while `registerHooks()` calls it synchronously.
export function load(url, context, nextLoad) {
  const result = nextLoad(url, context)
  if (result !== null && typeof result?.then === 'function') {
    return result.then(resolved => patch(url, resolved))
  }
  return patch(url, result)
}

function patch(url, result) {
  if (result.format !== 'module' || !url.includes('/node_modules/vitest/dist/')) return result
  if (result.source === undefined || result.source === null) return result
  const source = typeof result.source === 'string'
    ? result.source
    : Buffer.from(result.source).toString('utf8')
  if (!source.includes(BUNDLED_TIMEOUT)) return result
  return { ...result, source: source.replace(BUNDLED_TIMEOUT, WIDENED_TIMEOUT) }
}
