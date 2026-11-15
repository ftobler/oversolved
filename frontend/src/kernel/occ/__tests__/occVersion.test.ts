// The OCCT version is stated in prose in several places, and it once drifted:
// README said 7.4, the loaders said 7.5, while the installed build was V7_4_0p1.
// The single source of truth is frontend/occ.pin.json, which occ:install,
// verify and provision check the download against; this test fails when any
// statement disagrees with it, when the release tag names another version, or
// when the source mirror offers the source of another build.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND = join(HERE, '..', '..', '..', '..')
const ROOT = join(FRONTEND, '..')

const pin = JSON.parse(readFileSync(join(FRONTEND, 'occ.pin.json'), 'utf8')) as {
  repo: string
  tag: string
  occt: { version: string; tag: string; commit: string }
  build_commit: string
  artifacts: Record<string, string>
}

// Files that state the version to a reader. The first three must carry a
// statement (deleting it would otherwise silently satisfy the consistency
// scan); the rest are checked only for statements they happen to make.
const REQUIRED_STATEMENT = [
  'README.md',
  'frontend/src/kernel/occ/loadOcc.ts',
  'frontend/public/third_party/opencascade/README.md',
]
const SCANNED = [
  ...REQUIRED_STATEMENT,
  'docs/setup.md',
  'frontend/README.md',
  'frontend/src/kernel/occ/booleans.ts',
  'frontend/src/kernel/occ/occTypes.ts',
  'frontend/src/kernel/occ/primitives.ts',
  'frontend/src/kernel/occ/offsetShape.ts',
  'frontend/src/kernel/errors.ts',
  'frontend/src/kernel/solverConstants.ts',
  'frontend/src/testing/robustnessFuzz/chainReal.test.ts',
  'frontend/scripts/fetchOccSource.mjs',
]

// The spellings in the tree: prose "OCCT 8.0.1", the OCCT git tag "V8.0.1" (in
// the mirror's tarball name), and the older underscore tags "V7_4_0p1". All
// normalize to the dot form the pin records. Only a full major.minor.patch is a
// claim about the build; "OCCT 7.6 retired BRepOffset_Type" or "OCCT 8 binds
// no default arguments" is the history of an API, and is not scanned.
const CLAIM_PATTERNS = [
  /\bOCC(?:T)?\s+V?(\d+[._]\d+[._]\d+(?:p\d+)?)/g,
  /\bV(\d+_\d+_\d+(?:p\d+)?)\b/g,
  /\bV(\d+\.\d+\.\d+)\b/g,
]

function claimsIn(text: string): string[] {
  const out: string[] = []
  for (const pattern of CLAIM_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      out.push(match[1].replace(/_/g, '.').replace(/^V/, '').replace(/\.+$/, ''))
    }
  }
  return out
}

describe('OCCT version consistency', () => {
  it('every statement in the tree matches occ.pin.json', () => {
    const drift: string[] = []
    for (const rel of SCANNED) {
      const claims = claimsIn(readFileSync(join(ROOT, rel), 'utf8'))
      for (const claim of claims) {
        if (claim !== pin.occt.version) drift.push(`${rel}: says ${claim}`)
      }
    }
    expect(
      drift,
      `occ.pin.json pins OCCT ${pin.occt.version}; these statements disagree:\n` +
        drift.join('\n'),
    ).toEqual([])
  })

  it('the files that must state the version still do', () => {
    for (const rel of REQUIRED_STATEMENT) {
      const claims = claimsIn(readFileSync(join(ROOT, rel), 'utf8'))
      expect(claims, `${rel} no longer states the pinned OCCT version`).toContain(pin.occt.version)
    }
  })

  it('occ:install downloads the pinned release and verifies it', () => {
    const pkg = JSON.parse(readFileSync(join(FRONTEND, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['occ:install']).toBe('node scripts/occProvision.mjs install')
    expect(pkg.scripts['occ:provision']).toBe('node scripts/occProvision.mjs provision')
  })

  it('the pin names its release, the OCCT it built and a digest per file', () => {
    expect(pin.repo).toMatch(/^[\w.-]+\/[\w.-]+$/)
    expect(pin.tag).toBe(`occt-${pin.occt.version}-${/-(r\d+)$/.exec(pin.tag)?.[1]}`)
    expect(pin.occt.tag).toBe(`V${pin.occt.version}`)
    expect(pin.occt.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(pin.build_commit).toMatch(/^[0-9a-f]{40}$/)
    expect(Object.keys(pin.artifacts)).toEqual(expect.arrayContaining(['occt.js', 'occt.wasm']))
    for (const digest of Object.values(pin.artifacts)) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('the source mirror offers the source of the pinned build', () => {
    const mirror = readFileSync(join(ROOT, 'frontend', 'scripts', 'fetchOccSource.mjs'), 'utf8')
    expect(mirror).toContain(pin.occt.commit)
    expect(mirror).toContain(`V${pin.occt.version}`)
    expect(mirror).toContain(pin.build_commit)
  })
})
