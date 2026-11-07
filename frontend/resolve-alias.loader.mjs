/**
 * Node.js loader hook that resolves the Vite path alias `@/` to `./src/`
 * (relative to the project root), and adds `.ts` extension resolution
 * including directory → index.ts fallback. Used by the thread-timeout guard
 * so the forked runner can import source modules without vitest's module
 * hooks.
 *
 * Paired with --experimental-strip-types, which Node only has from 22.6. The
 * package floor stays 20.19 for the app and vitest, so a local checkout below
 * 22.6 cannot start the forked watchdog children at all; those suites skip
 * there rather than report every seed as a crash.
 *
 * Two forms of the same hook: `resolve` for the off-thread `register()` API
 * and `resolveSync` for the in-thread `registerHooks()` API. The off-thread
 * form costs a cross-thread round trip per module (see
 * scripts/registerLoaderHooks.mjs for the measurement), so
 * scripts/resolveAlias.register.mjs picks the in-thread one where Node
 * supports it. Both walk the same candidate list.
 */

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const root = path.dirname(fileURLToPath(import.meta.url))

// The specifiers to try, in order. The first failure is the one reported,
// except for a directory's index.ts: once that file exists it is the answer,
// so its own resolution error is the meaningful one (`final`).
function* candidates(specifier) {
  const target = specifier.startsWith('@/') ? path.join(root, 'src', specifier.slice(2)) : specifier
  yield { spec: target, final: false }
  if (target !== specifier) yield { spec: specifier, final: false }
  if (!path.extname(target)) {
    yield { spec: target + '.ts', final: false }
    const indexPath = path.join(target, 'index.ts')
    if (fs.existsSync(indexPath)) yield { spec: indexPath, final: true }
  }
}

export async function resolve(specifier, context, nextResolve) {
  let firstError
  for (const { spec, final } of candidates(specifier)) {
    if (final) return nextResolve(spec, context)
    try {
      return await nextResolve(spec, context)
    } catch (err) {
      firstError ??= err
    }
  }
  throw firstError
}

export function resolveSync(specifier, context, nextResolve) {
  let firstError
  for (const { spec, final } of candidates(specifier)) {
    if (final) return nextResolve(spec, context)
    try {
      return nextResolve(spec, context)
    } catch (err) {
      firstError ??= err
    }
  }
  throw firstError
}
