// Standing policy: every runtime asset this app loads must be same-origin.
// No CDN, no third-party host, on any code path a browser can reach.
//
// The src scan below catches hosts we introduce ourselves; the config
// assertions catch a dependency (troika-three-text) resolving one for us
// through its own default. dist/ is deliberately not grepped: troika ships a
// CDN host literal in code paths that are dead once defaultFontURL is set, so
// a dist grep would flag a violation that cannot fire. The config assertions
// prove reachability directly instead.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..', '..', '..')
const FRONTEND = join(SRC, '..')

// Hosts that would mean a runtime asset is being fetched from someone else.
const CDN_HOSTS = /\b(?:cdn\.|jsdelivr|unpkg|cdnjs|fonts\.googleapis|fonts\.gstatic|esm\.sh|skypack)\b/i

// Namespaces and prose are inert: an XML namespace URI is never dereferenced,
// and a URL inside a comment or an error message is not a load. Excluding them
// keeps the guard from crying wolf, which is what gets a guard deleted.
const INERT = [
  /https?:\/\/(?:www\.)?w3\.org\/[^\s'"`)]*/gi,  // SVG/XML namespaces
  /\/\*[\s\S]*?\*\//g,  // block comments
  /(?:^|\s)\/\/[^\n]*/g,  // line comments
]

function filesUnder(dir: string, extensions: RegExp): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(full, extensions))
    else if (extensions.test(entry.name)) out.push(full)
  }
  return out
}

function liveText(file: string): string {
  let text = readFileSync(file, 'utf8')
  for (const pattern of INERT) text = text.replace(pattern, '')
  return text
}

describe('no external-origin runtime assets', () => {
  it('references no CDN host on a live path in src/', () => {
    const offenders = filesUnder(SRC, /\.(ts|tsx|css|html)$/)
      .filter(f => !f.includes('__tests__'))
      .filter(f => CDN_HOSTS.test(liveText(f)))
      .map(f => f.slice(SRC.length + 1))

    expect(offenders).toEqual([])
  })

  it('serves the 3D label font from our own origin', async () => {
    const { LABEL_FONT } = await import('@/components/Viewport/labelFont')

    // `undefined` is the value that hands font resolution back to troika's
    // own default, so it is not a missing config, it is the bug.
    expect(LABEL_FONT).toBeDefined()
    expect(LABEL_FONT).not.toMatch(/^https?:/)
    expect(LABEL_FONT).toMatch(/^\//)
    expect(LABEL_FONT).not.toMatch(CDN_HOSTS)
  })

  it('ships the font file it points at, in a format troika can parse', async () => {
    const { LABEL_FONT } = await import('@/components/Viewport/labelFont')

    // A same-origin path that 404s renders no text at all, and the path is a
    // string no compiler checks.
    const onDisk = join(FRONTEND, 'public', LABEL_FONT)
    expect(existsSync(onDisk)).toBe(true)

    // troika parses fonts with Typr, which reads WOFF1 and does NOT support
    // WOFF2. A .woff2 here would fail at runtime, not at build time.
    const magic = readFileSync(onDisk).subarray(0, 4).toString('latin1')
    expect(magic).toBe('wOFF')
  })

  it('leaves troika no reason to resolve a font over the network', async () => {
    // The actual reachability proof: troika only runs its network-backed
    // unicode resolver when defaultFontURL is falsy; importing labelFont must
    // have configured it to the vendored file.
    vi.resetModules()
    const configured: unknown[] = []
    vi.doMock('troika-three-text', () => ({
      configureTextBuilder: (config: unknown) => { configured.push(config) },
      preloadFont: (_o: unknown, cb: () => void) => cb(),
    }))

    const { LABEL_FONT } = await import('@/components/Viewport/labelFont')

    expect(configured).toEqual([{ defaultFontURL: LABEL_FONT }])
    vi.doUnmock('troika-three-text')
    vi.resetModules()
  })

  it('renders every drei <Text> through the one shared font constant', () => {
    // Not a style rule. drei keys its font suspension on
    // ['troika-text', font, characters], and suspend-react compares each slot
    // by ===, so two <Text> sites naming different fonts land in different
    // cache entries: the startup warm-up fills one and the other suspends cold
    // on its first mount. Since R3F wraps all Canvas children in a single
    // Suspense boundary, that cold suspend blanks the whole viewport -- for
    // AngleDial, in the middle of a rotation drag. A literal font path here,
    // even a correct same-origin one, is therefore still a bug.
    const drei = /import\s*\{[^}]*\bText\b[^}]*\}\s*from\s*'@react-three\/drei'/

    const textSites = filesUnder(SRC, /\.tsx$/)
      .filter(f => !f.includes('__tests__'))
      .filter(f => drei.test(readFileSync(f, 'utf8')))

    // Guards the guard: if the import shape changes and this matches nothing,
    // the assertions below would pass vacuously.
    expect(textSites.length).toBeGreaterThanOrEqual(2)

    for (const file of textSites) {
      const source = readFileSync(file, 'utf8')
      const where = file.slice(SRC.length + 1)
      expect(source, `${where} must import the shared label font`)
        .toMatch(/import\s*\{[^}]*\bLABEL_FONT\b[^}]*\}\s*from\s*'@\/components\/Viewport\/labelFont'/)
      expect(source, `${where} must pass font={LABEL_FONT} to <Text>`)
        .toMatch(/font=\{LABEL_FONT\}/)
      expect(source, `${where} must not hardcode a font path`)
        .not.toMatch(/font="/)
    }
  })

  it('keeps the font somewhere Vite copies verbatim, not somewhere it hashes', async () => {
    // Deliberately asserted against public/ rather than dist/.
    //
    // The obvious version of this test greps the built dist/, and it is a trap
    // here: `just frontend` runs lint, then test, THEN build, so any dist/ a
    // test can see is the previous build. It would have gone red on this very
    // commit -- the font is newer than the dist on disk -- and green again on a
    // rerun, which is the kind of flake that gets a guard deleted.
    //
    // public/ is the sound equivalent. Vite copies publicDir into the dist root
    // byte-for-byte and without hashing the name, which is exactly why the
    // absolute '/fonts/...' path in LABEL_FONT resolves at runtime. That is the
    // same contract env.hdr already relies on. An import-based asset would get
    // a content hash and this literal path would 404.
    const { LABEL_FONT } = await import('@/components/Viewport/labelFont')

    expect(existsSync(join(FRONTEND, 'public', LABEL_FONT))).toBe(true)
  })
})
