// The wordmark gradient is CSS only and jsdom applies no stylesheet, so the
// sheets that own it are the source of truth: one token in the global sheet,
// consumed by both the header logo and the splash title. Pinning the token's
// value here keeps the two from drifting apart again.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '../..')
const INDEX_CSS = readFileSync(join(SRC, 'index.css'), 'utf8')
const HEADER_CSS = readFileSync(join(SRC, 'components/layout/AppHeader.css'), 'utf8')
const SPLASH_CSS = readFileSync(join(SRC, 'components/SplashScreen.css'), 'utf8')

// The declarations of the first rule whose selector is exactly `selector`.
// index.css nests a media query inside :root, so its tokens are read from the
// whole sheet instead of a body.
function ruleBody(css: string, file: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `${selector} rule in ${file}`).not.toBeNull()
  return match![1]
}

function token(name: string): string {
  const match = new RegExp(`(?:^|\\n)\\s*${name}:\\s*([^;]+);`).exec(INDEX_CSS)
  expect(match, `${name} in index.css`).not.toBeNull()
  return match![1].trim()
}

describe('brand gradient', () => {
  it('defines the header colours once in the global sheet', () => {
    expect(token('--brand-gradient')).toBe('linear-gradient(90deg, #81c784, #f06292)')
    expect(token('--brand-gradient-hover')).toBe('linear-gradient(90deg, #c7c781, #dd62f0)')
  })

  it('paints the header logo from the token', () => {
    expect(ruleBody(HEADER_CSS, 'AppHeader.css', '.logo')).toMatch(/background:\s*var\(--brand-gradient\);/)
    expect(ruleBody(HEADER_CSS, 'AppHeader.css', '.logo:hover')).toMatch(/background:\s*var\(--brand-gradient-hover\);/)
    // No literal gradient may survive here, or the token stops being the source.
    expect(HEADER_CSS).not.toMatch(/linear-gradient/)
  })

  it('paints the splash title with the same token and clip', () => {
    const title = ruleBody(SPLASH_CSS, 'SplashScreen.css', '.splash-screen-title')
    expect(title).toMatch(/background:\s*var\(--brand-gradient\);/)
    expect(title).toMatch(/-webkit-background-clip:\s*text;/)
    expect(title).toMatch(/background-clip:\s*text;/)
    expect(title).toMatch(/-webkit-text-fill-color:\s*transparent;/)
    expect(SPLASH_CSS).not.toMatch(/linear-gradient/)
  })
})
