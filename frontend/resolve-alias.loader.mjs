/**
 * Node.js loader hook that resolves the Vite path alias `@/` to `./src/`
 * (relative to the project root), and adds `.ts` extension resolution
 * including directory → index.ts fallback. Used by the thread-timeout guard
 * so the forked runner can import source modules without vitest's module
 * hooks.
 *
 * Paired with --experimental-strip-types (Node 22.6+) so plain .ts files
 * load without a build step.
 */

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const root = path.resolve(fileURLToPath(import.meta.url), '..')

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const aliased = path.join(root, 'src', specifier.slice(2))
    return resolveWithExt(aliased, specifier, context, nextResolve)
  }
  return resolveWithExt(specifier, specifier, context, nextResolve)
}

async function resolveWithExt(target, original, context, nextResolve) {
  try {
    return await nextResolve(target, context)
  } catch (_err) {
    if (target !== original) {
      try { return await nextResolve(original, context) } catch { /* fall through */ }
    }
    if (!path.extname(target)) {
      try { return await nextResolve(target + '.ts', context) } catch { /* fall through */ }
      const indexPath = path.join(target, 'index.ts')
      if (fs.existsSync(indexPath)) {
        return nextResolve(indexPath, context)
      }
    }
    throw _err
  }
}
