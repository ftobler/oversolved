/**
 * Node.js loader hook that resolves the Vite path alias `@/` to `./src/`
 * (relative to the project root). Used by the thread-timeout guard so the
 * forked runner can import source modules without vitest's module hooks.
 *
 * Paired with --experimental-strip-types (Node 22.6+) so plain .ts files
 * load without a build step.
 */

import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(fileURLToPath(import.meta.url), '..')

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const target = path.join(root, 'src', specifier.slice(2))
    return nextResolve(target, context)
  }
  return nextResolve(specifier, context)
}
