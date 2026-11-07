/**
 * Node loader for the headless entries (the drive CLI and the MCP server):
 * the regen:corpus recipe's alias resolver plus an import.meta.env shim.
 *
 * The app's source reads `import.meta.env` (Vite's define target) in a few hot
 * paths, and plain Node has no such property: the expression throws. The
 * entries are not Vite builds, so this loader rewrites the expression to a
 * literal production-shaped env before Node strips the types. Only the app's
 * own .ts sources are rewritten; node_modules are untouched.
 *
 * `load` serves the off-thread `register()` API and `loadSync` the in-thread
 * `registerHooks()` API; scripts/driveCli.register.mjs picks between them.
 */

export * from '../resolve-alias.loader.mjs'

const ENV_LITERAL = '({ DEV: false, MODE: "production", BASE_URL: "/" })'

function shimEnv(url, result) {
  if (!url.startsWith('file:')) return result
  if (url.includes('/node_modules/')) return result
  if (!url.includes('/src/') && !url.includes('/scripts/')) return result
  if (!url.endsWith('.ts') && !url.endsWith('.tsx')) return result
  const source = typeof result.source === 'string'
    ? result.source
    : Buffer.from(result.source).toString('utf8')
  return {
    ...result,
    source: source.replace(/import\.meta\.env(?![\w$])/g, ENV_LITERAL),
  }
}

export async function load(url, context, nextLoad) {
  return shimEnv(url, await nextLoad(url, context))
}

export function loadSync(url, context, nextLoad) {
  return shimEnv(url, nextLoad(url, context))
}
