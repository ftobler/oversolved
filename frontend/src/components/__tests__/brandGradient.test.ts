// The wordmark gradient and typography are CSS only and jsdom applies no
// stylesheet, so the sheets that own them are the source of truth: tokens in
// the global sheet, consumed by both the header logo and the splash title.
// Pinning the tokens' values here keeps the two from drifting apart again.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SPLASH_TITLE_FONT } from '@/hooks/useFontReady'

const SRC = join(__dirname, '../..')
const INDEX_CSS = readFileSync(join(SRC, 'index.css'), 'utf8')
const HEADER_CSS = readFileSync(join(SRC, 'components/layout/AppHeader.css'), 'utf8')
const SPLASH_CSS = readFileSync(join(SRC, 'components/SplashScreen.css'), 'utf8')

// The declarations of the first rule whose selector is exactly `selector`.
// index.css nests a media query inside :root, so its tokens are read from the
// whole sheet instead of a body.
function rulePart(css: string, file: string, selector: string): string {
  const match = ruleParts(css, selector)[0]
  expect(match, `${selector} rule in ${file}`).toBeDefined()
  return match
}

// Every block whose selector is exactly `selector`, across media queries too:
// a later block can re-declare a property and override the base rule, so a
// guard that only reads the first block cannot see the drift.
function ruleParts(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...css.matchAll(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map(m =>
    m[1],
  )
}

function token(name: string): string {
  const match = new RegExp(`(?:^|\\n)\\s*${name}:\\s*([^;]+);`).exec(INDEX_CSS)
  expect(match, `${name} in index.css`).not.toBeNull()
  return match![1].trim()
}

// The first family in a CSS font stack, with its quotes removed: `'Roboto',
// system-ui, sans-serif` -> `Roboto`.
function firstFamily(stack: string): string {
  return stack.split(',')[0].trim().replace(/^['"]|['"]$/g, '')
}

// Every value declared for `property` in one rule body, in source order, so a
// literal left beside the token cannot hide behind the token's own match.
function declarations(rule: string, property: string): string[] {
  return [...rule.matchAll(new RegExp(`(?:^|;|\\s)${property}:\\s*([^;]+);`, 'g'))].map(m =>
    m[1].trim(),
  )
}

describe('brand wordmark', () => {
  it('defines the header colours once in the global sheet', () => {
    expect(token('--brand-gradient')).toBe('linear-gradient(90deg, #81c784, #f06292)')
    expect(token('--brand-gradient-hover')).toBe('linear-gradient(90deg, #c7c781, #dd62f0)')
  })

  it('defines the wordmark typography once in the global sheet', () => {
    expect(token('--brand-weight')).toBe('700')
    expect(token('--brand-tracking')).toBe('normal')
    expect(INDEX_CSS.match(/--brand-weight:/g)).toHaveLength(1)
    expect(INDEX_CSS.match(/--brand-tracking:/g)).toHaveLength(1)
  })

  it('gives every wordmark rule the token typography and family', () => {
    const expected = [
      ['font-family', 'var(--sans)'],
      ['font-weight', 'var(--brand-weight)'],
      ['letter-spacing', 'var(--brand-tracking)'],
    ]
    for (const [css, file, selector] of [
      [HEADER_CSS, 'AppHeader.css', '.logo'],
      [SPLASH_CSS, 'SplashScreen.css', '.splash-screen-title'],
    ]) {
      const rules = ruleParts(css, selector)
      expect(rules.length, `${selector} rules in ${file}`).toBeGreaterThan(0)
      for (const rule of rules) {
        for (const [property, value] of expected) {
          // Omitting the property is fine (the media block only hides the
          // logo); declaring it anywhere must use the token, never a literal.
          const values = declarations(rule, property)
          if (values.length > 0) {
            expect(values, `${selector} ${property} in ${file}`).toEqual([value])
          }
        }
      }
    }
  })

  it('waits for the face the wordmark token declares', () => {
    const title = rulePart(SPLASH_CSS, 'SplashScreen.css', '.splash-screen-title')
    const sizes = declarations(title, 'font-size')
    expect(sizes).toHaveLength(1)
    // The hook's load shorthand must name the weight, size and first family the
    // title actually renders, or the hold gates on a face nothing draws.
    expect(SPLASH_TITLE_FONT).toBe(
      `${token('--brand-weight')} ${sizes[0]} ${firstFamily(token('--sans'))}`,
    )
  })

  it('paints the header logo from the token', () => {
    expect(rulePart(HEADER_CSS, 'AppHeader.css', '.logo')).toMatch(/background:\s*var\(--brand-gradient\);/)
    expect(rulePart(HEADER_CSS, 'AppHeader.css', '.logo:hover')).toMatch(/background:\s*var\(--brand-gradient-hover\);/)
    // No literal gradient may survive here, or the token stops being the source.
    expect(HEADER_CSS).not.toMatch(/linear-gradient/)
  })

  it('paints the splash title with the same token and clip', () => {
    const title = rulePart(SPLASH_CSS, 'SplashScreen.css', '.splash-screen-title')
    expect(title).toMatch(/background:\s*var\(--brand-gradient\);/)
    expect(title).toMatch(/-webkit-background-clip:\s*text;/)
    expect(title).toMatch(/background-clip:\s*text;/)
    expect(title).toMatch(/-webkit-text-fill-color:\s*transparent;/)
    expect(SPLASH_CSS).not.toMatch(/linear-gradient/)
  })

  it('keeps the loading title in place and in the accessibility tree', () => {
    const pending = rulePart(SPLASH_CSS, 'SplashScreen.css', '.splash-screen-title-pending')
    // Opacity, not display or visibility: the heading keeps its layout box and
    // stays announced while the font loads.
    expect(pending).toMatch(/opacity:\s*0;/)
    expect(pending).not.toMatch(/display:\s*none/)
    expect(pending).not.toMatch(/visibility:\s*hidden/)
  })
})
