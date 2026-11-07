// Register a loader's hooks in-thread where Node allows it, off-thread otherwise.
//
// `register()` runs the hooks on a separate loader thread, so every resolve and
// load is a blocking cross-thread round trip: profiled on the drive CLI the
// main thread sat ~1.6 s in that wait during a 4.6 s box build, more than the
// OCC work itself. The synchronous `registerHooks()` runs them in the importing
// thread, and a spawn got ~1.2 s faster (4.6 s to 3.4 s). The version
// gate matches scripts/vitestRpcTimeout.register.mjs: Node 22 ships
// `registerHooks` too, but there sync hooks broke require(esm) inside CJS
// modules, so 22 and 23 keep the off-thread path: the same `register()` of the
// same loader file that `--loader` used, which ignores the extra sync exports.
import * as nodeModule from 'node:module'

const nodeMajor = Number(process.versions.node.split('.')[0])

const inThreadHooks = nodeMajor >= 24 && typeof nodeModule.registerHooks === 'function'

/**
 * `loaderUrl` is the loader module for the off-thread fallback, `syncHooks`
 * the same hooks in their synchronous form.
 */
export function registerLoaderHooks(loaderUrl, syncHooks) {
  if (inThreadHooks) nodeModule.registerHooks(syncHooks)
  else nodeModule.register(loaderUrl)
}
