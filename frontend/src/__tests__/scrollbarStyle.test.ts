// The scrollbar look is one global block in index.css. jsdom applies no
// stylesheet and has no scrollbar, so the sheet itself is the source of truth:
// the shared tokens, the WebKit pseudo-elements, and the Firefox fallback. A
// second rule in a component sheet would bring back that one list's grey track
// and arrow buttons, so the guard below keeps the subject in one place.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(__dirname, '..')
const INDEX_CSS = readFileSync(join(SRC, 'index.css'), 'utf8')

// An exception would carry its reason here, next to its path.
const ALLOWED = new Set<string>()

const SCROLLBAR_DECLARATION = /::-webkit-scrollbar|scrollbar-width|scrollbar-color/

function nameOf(path: string): string {
  return relative(SRC, path).split(/[\\/]/).join('/')
}

function stylesheets(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.css')) out.push(path)
    }
  }
  walk(SRC)
  return out
}

// The declarations of the first rule whose selector is exactly `selector`.
function rulePart(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = INDEX_CSS.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `${selector} rule in index.css`).not.toBeNull()
  return match![1]
}

function token(name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(rulePart(':root'))
  expect(match, `${name} in :root`).not.toBeNull()
  return match![1].trim()
}

const supportsAt = INDEX_CSS.indexOf('@supports not selector(::-webkit-scrollbar)')
const firefoxBlock = supportsAt === -1 ? '' : INDEX_CSS.slice(supportsAt)

describe('global scrollbar style', () => {
  it('declares the size and the two thumb colours as tokens', () => {
    expect(token('--scrollbar-size')).toMatch(/^\d+px$/)
    expect(Number.parseFloat(token('--scrollbar-size'))).toBeLessThanOrEqual(8)
    expect(token('--scrollbar-thumb')).not.toBe('')
    expect(token('--scrollbar-thumb-hover')).not.toBe('')
  })

  it('sizes the bar from the token and drops the track and the arrows', () => {
    const bar = rulePart('::-webkit-scrollbar')
    expect(bar).toMatch(/width:\s*var\(--scrollbar-size\)/)
    expect(bar).toMatch(/height:\s*var\(--scrollbar-size\)/)

    expect(INDEX_CSS).toMatch(
      /::-webkit-scrollbar-track,\s*\n::-webkit-scrollbar-corner\s*\{\s*background:\s*transparent;/,
    )
    expect(rulePart('::-webkit-scrollbar-button')).toMatch(/display:\s*none/)
  })

  it('gives the thumb the token colour and a rounded shape', () => {
    const thumb = rulePart('::-webkit-scrollbar-thumb')
    expect(thumb).toMatch(/background:\s*var\(--scrollbar-thumb\)/)
    // Any radius is enough to round it; the value is a taste knob, not a fact.
    expect(thumb).toMatch(/border-radius:\s*[^;]+;/)

    expect(INDEX_CSS).toMatch(
      /::-webkit-scrollbar-thumb:hover,\s*\n::-webkit-scrollbar-thumb:active\s*\{\s*background:\s*var\(--scrollbar-thumb-hover\);/,
    )
  })

  it('falls back to the standard properties for Firefox alone', () => {
    expect(supportsAt).toBeGreaterThan(-1)
    expect(firefoxBlock).toMatch(/\* \{[^}]*scrollbar-width:\s*thin;[^}]*\}/)
    // The track is the second `scrollbar-color` value.
    expect(firefoxBlock).toMatch(
      /scrollbar-color:\s*var\(--scrollbar-thumb\)\s+transparent;/,
    )
  })

  it('keeps the standard properties out of Chromium, where they would win', () => {
    // Chromium 121+ ignores the ::-webkit rules once the standard properties
    // are set, and its `thin` is wider than 6px, so the fallback must be
    // unreachable there.
    expect(INDEX_CSS.slice(0, Math.max(supportsAt, 0))).not.toMatch(
      /scrollbar-width|scrollbar-color/,
    )
  })
})

describe('one scrollbar rule for the app', () => {
  it('keeps every scrollbar declaration in index.css', () => {
    const sheets = stylesheets()
    // A positive control: the sweep reaches the global sheet and the pattern
    // catches it, so an empty offender list means something.
    expect(sheets.map(nameOf)).toContain('index.css')
    expect(SCROLLBAR_DECLARATION.test(INDEX_CSS)).toBe(true)

    const offenders = sheets
      .map(path => ({ path, name: nameOf(path) }))
      .filter(({ name }) => name !== 'index.css' && !ALLOWED.has(name))
      .filter(({ path }) => SCROLLBAR_DECLARATION.test(readFileSync(path, 'utf8')))
      .map(({ name }) => name)
    expect(offenders).toEqual([])
  })
})
