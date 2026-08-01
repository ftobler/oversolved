// R3F wraps ALL <Canvas> children in exactly one React.Suspense. A leaf that
// throws a promise therefore does not blank itself, it blanks the entire scene:
// the boundary re-enters its fallback and R3F calls hideInstance() on every
// object below it. That has bitten twice from two different directions (drei's
// <Text> waiting on its font, once for the plane labels and once for the
// AngleDial readout mid-rotation-drag), and each fix was specific to the leaf
// that broke. This is the general rule instead: a suspending leaf carries its
// own <Suspense fallback={null}> so the rest of the scene keeps rendering.
//
// Honest about what it is: a lint-shaped heuristic over source text, not a
// proof. It cannot see a suspending call that reaches a component through a
// hook of ours, it does not follow a renamed import (`Text as DreiText`), and
// it cannot tell a boundary that actually wraps the call from one somewhere
// else in the same file. The semantic counterpart is
// Viewport/__tests__/planeLabelFont.test.tsx, which renders the real drei <Text>
// against the real suspend-react cache and is the only test that observes the
// behaviour rather than the source.
//
// It lives beside the components because that is what the rule is about, but it
// scans all of `src/`: every <Canvas> child sits under components/ today, and a
// suspending leaf added somewhere else should not be invisible for that reason.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const SRC = join(__dirname, '..', '..')

function collectFiles(dir: string, exts: string[]): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) results.push(...collectFiles(full, exts))
    else if (exts.includes(extname(entry))) results.push(full)
  }
  return results
}

// Each entry is a source pattern plus what it is, so a violation report names
// the hazard rather than a regex. `suspend`/`preload` are suspend-react's own
// API; the rest are drei/fiber wrappers that call it (or useLoader) internally.
const SUSPENDING_APIS: readonly { readonly what: string; readonly re: RegExp }[] = [
  { what: "suspend-react's suspend()", re: /\bsuspend\s*\(/ },
  { what: "suspend-react's preload()", re: /\bpreload\s*\(/ },
  { what: 'useLoader', re: /\buseLoader\s*\(/ },
  { what: 'useTexture', re: /\buseTexture\s*\(/ },
  { what: 'useGLTF', re: /\buseGLTF\s*\(/ },
  { what: 'useFont', re: /\buseFont\s*\(/ },
  { what: 'useEnvironment', re: /\buseEnvironment\s*\(/ },
  { what: 'useCubeTexture', re: /\buseCubeTexture\s*\(/ },
  { what: 'useVideoTexture', re: /\buseVideoTexture\s*\(/ },
  { what: 'useKTX2', re: /\buseKTX2\s*\(/ },
  { what: 'useFBX', re: /\buseFBX\s*\(/ },
  // Components rather than calls: drei's <Text> suspends on its font atlas,
  // <Text3D> on its typeface JSON, and <Environment> on its HDR -- all through
  // suspend-react. <Text3D> needs its own entry because the <Text> pattern
  // deliberately requires a delimiter and so does not match it.
  { what: "drei's <Text>", re: /<Text[\s/>]/ },
  { what: "drei's <Text3D>", re: /<Text3D[\s/>]/ },
  { what: "drei's <Environment>", re: /<Environment[\s/>]/ },
]

// A file may skip the boundary rule only with a reason written down here.
// Every entry must still match a real file: a stale exemption silently widens
// the rule, so the test fails on one that no longer applies.
const ALLOWED: Readonly<Record<string, string>> = {
  'components/Viewport/labelFont.ts':
    'The warm-up module itself. Its preload() is suspend-react\'s non-throwing '
    + 'registration call, made at app startup outside any render, so there is '
    + 'nothing for a boundary to catch.',
  'components/Viewport/AssemblyViewport.tsx':
    'Known gap, deliberately recorded rather than silently fixed: <Environment '
    + 'files="/env.hdr"> suspends the whole Canvas on first mount. Wrapping it '
    + 'would paint the scene unlit until the HDR lands, which is a visible '
    + 'change to first paint and the user\'s call, not this guard\'s.',
  'components/Viewport/index.tsx':
    'Same <Environment files="/env.hdr"> as AssemblyViewport, same open call.',
}

// Comments are stripped before the scan, and that is load-bearing twice over: a
// prose mention of `useLoader(` is a false positive, and -- worse -- it would
// keep an ALLOWED entry looking like it still applies long after the real usage
// was deleted, since the staleness check reads the same text. Same patterns as
// Viewport/__tests__/noCdnAssets.test.ts.
const COMMENTS = [/\/\*[\s\S]*?\*\//g, /(?:^|\s)\/\/[^\n]*/g]

function liveText(file: string): string {
  let text = readFileSync(file, 'utf8')
  for (const pattern of COMMENTS) text = text.replace(pattern, '')
  return text
}

const sources = collectFiles(SRC, ['.ts', '.tsx'])
  .filter(f => !f.includes('__tests__') && !/\.test\.tsx?$/.test(f))
  .map(f => ({ path: f.slice(SRC.length + 1), text: liveText(f) }))

/** The suspending APIs a file names, empty when it names none. */
function hazardsIn(text: string): string[] {
  return SUSPENDING_APIS.filter(api => api.re.test(text)).map(api => api.what)
}

describe('suspending Canvas leaves', () => {
  it('scans the source tree it claims to scan', () => {
    // Guards the guard: a broken walk, an over-eager filter, or comment
    // stripping that ate real code would leave every assertion below passing on
    // an empty set.
    expect(sources.length).toBeGreaterThan(150)
    expect(sources.filter(f => hazardsIn(f.text).length > 0).length).toBeGreaterThanOrEqual(
      Object.keys(ALLOWED).length + 1,
    )
  })

  it('gives every suspending leaf its own Suspense boundary', () => {
    const violations = sources
      .filter(f => !(f.path in ALLOWED))
      .filter(f => hazardsIn(f.text).length > 0 && !f.text.includes('<Suspense'))
      .map(f => `${f.path} uses ${hazardsIn(f.text).join(', ')} with no local <Suspense>`)
      .sort()
    expect(violations).toEqual([])
  })

  it('keeps no allowlist entry that has stopped applying', () => {
    // Two ways an exemption rots: the file moves or goes away, or it stops
    // suspending. Either leaves a written exemption covering nothing, and the
    // next file to land on that path inherits it for free.
    const stale = Object.keys(ALLOWED).filter(path => {
      const file = sources.find(f => f.path === path)
      return !file || hazardsIn(file.text).length === 0
    })
    expect(stale).toEqual([])
  })

  it('states a reason for every exemption', () => {
    for (const [path, reason] of Object.entries(ALLOWED)) {
      expect(reason.length, `${path} needs a written reason`).toBeGreaterThan(40)
    }
  })
})
