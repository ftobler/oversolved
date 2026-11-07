// @vitest-environment node
/**
 * Guards the prefix order of every stylesheet under src.
 *
 * The production minifier (lightningcss, Vite's default) folds a prefixed
 * declaration and its unprefixed twin into one property, and the later one
 * wins. `backdrop-filter: X; -webkit-backdrop-filter: X` therefore ships as
 * the prefix alone, which Chrome and Firefox ignore: the glass panels lost
 * their blur in the build while `vite dev`, which does not minify, kept it.
 * The unprefixed form must follow its -webkit- twin within a rule.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(__dirname, '../../../')

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return cssFiles(path)
    return entry.name.endsWith('.css') ? [path] : []
  })
}

// Each `{ ... }` body without nested braces is one declaration block; the
// property names in it are read in order, comments blanked first so prose
// mentioning a property cannot trip the scan.
function prefixAfterUnprefixed(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const found: string[] = []
  for (const block of text.matchAll(/\{([^{}]*)\}/g)) {
    const props = [...block[1].matchAll(/(?:^|;)\s*(-?[a-z-]+)\s*:/g)].map((m) => m[1])
    props.forEach((prop, i) => {
      if (!prop.startsWith('-webkit-')) return
      const bare = prop.slice('-webkit-'.length)
      if (props.slice(0, i).includes(bare)) found.push(prop)
    })
  }
  return found
}

describe('css prefix order', () => {
  it('flags a -webkit- declaration after its unprefixed twin', () => {
    expect(prefixAfterUnprefixed('.a{backdrop-filter:x;-webkit-backdrop-filter:x}'))
      .toEqual(['-webkit-backdrop-filter'])
    expect(prefixAfterUnprefixed('.a{-webkit-backdrop-filter:x;backdrop-filter:x}')).toEqual([])
  })

  it('every stylesheet puts the unprefixed property last', () => {
    const offenders = cssFiles(SRC).flatMap((file) =>
      prefixAfterUnprefixed(readFileSync(file, 'utf8')).map((p) => `${relative(SRC, file)}: ${p}`))
    expect(offenders).toEqual([])
  })
})
