/**
 * Node loader for the drive CLI: the regen:corpus recipe's alias resolver plus
 * an import.meta.env shim.
 *
 * The app's source reads `import.meta.env` (Vite's define target) in a few hot
 * paths, and plain Node has no such property: the expression throws. The CLI
 * is not a Vite build, so this loader rewrites the expression to a literal
 * production-shaped env before Node strips the types. Only the app's own .ts
 * sources are rewritten; node_modules are untouched.
 */

export * from '../resolve-alias.loader.mjs'

const ENV_LITERAL = '({ DEV: false, MODE: "production", BASE_URL: "/" })'

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context)
  if (!url.startsWith('file:')) return result
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
