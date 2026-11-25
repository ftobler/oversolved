// jsdom applies no stylesheet, so the icon column's CSS is pinned against the
// sheet itself: no fixed-width disclosure spacer may survive, and the icon's
// size must stay the one shared by both editors' row rules.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ASSEMBLY_CSS = readFileSync(join(__dirname, '../../../pages/Assembly.css'), 'utf8')
const STYLES = ASSEMBLY_CSS.replace(/\/\*[\s\S]*?\*\//g, '')

describe('assembly row icon column CSS', () => {
  it('has no fixed-width disclosure spacer', () => {
    expect(STYLES).not.toMatch(/\.subassembly-chevron-spacer/)
    const chevron = STYLES.match(/\.subassembly-chevron[^{}]*\{([^}]*)\}/)?.[1] ?? ''
    expect(chevron).toMatch(/width:\s*18px/)
  })

  it('does not restyle the shared feature icon', () => {
    const selectors = [...STYLES.matchAll(/(?:^|\n)([^{}\n]+)\{/g)]
      .flatMap(match => match[1].split(',').map(part => part.trim()))
    expect(selectors.filter(selector => selector.includes('.feature-icon'))).toEqual([])
  })
})
