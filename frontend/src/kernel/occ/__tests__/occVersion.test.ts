// The OCCT version is stated in prose in several places, and before this test
// it drifted: README said 7.4, the loaders said 7.5, while the installed
// opencascade.js build (and its LGPL source mirror) is V7_4_0p1. The single
// source of truth is frontend/occ.pin.json, which occ:install/occ:provision
// verify against; this test fails when any statement disagrees with it or when
// the install script pins a different package version.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND = join(HERE, '..', '..', '..', '..')
const ROOT = join(FRONTEND, '..')

const pin = JSON.parse(readFileSync(join(FRONTEND, 'occ.pin.json'), 'utf8')) as {
  package: string
  version: string
  registry: { tarball: string; integrity: string }
  occt: { version: string; commit: string }
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
  'frontend/src/kernel/occ/booleans.ts',
  'frontend/src/kernel/occ/occTypes.ts',
  'frontend/src/kernel/occ/primitives.ts',
  'frontend/src/kernel/errors.ts',
  'frontend/src/kernel/solverConstants.ts',
  'frontend/src/testing/robustnessFuzz/chainReal.test.ts',
  'frontend/scripts/fetchOccSource.mjs',
]

// Two spellings appear in the tree: prose "OCCT 7.4.0p1" and the OCCT git tag
// "V7_4_0p1" (in the mirror's tarball name). Both normalize to the same dot
// form the pin records.
const CLAIM_PATTERNS = [
  /\bOCC(?:T)?\s+V?(\d[\d._]*p?\d*)/g,
  /\bV(\d+_\d+_\d+p?\d*)\b/g,
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

  it('occ:install pins the package version recorded in the pin', () => {
    const pkg = JSON.parse(readFileSync(join(FRONTEND, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    const install = pkg.scripts['occ:install']
    expect(install, 'occ:install no longer pins an explicit version').toContain(
      `${pin.package}@${pin.version}`,
    )
    expect(install, 'occ:install must verify the install against the pin').toContain(
      'scripts/occProvision.mjs verify',
    )
  })

  it('the pin names a registry tarball with an integrity hash and per-file digests', () => {
    expect(pin.registry.tarball).toBe(
      `https://registry.npmjs.org/${pin.package}/-/${pin.package}-${pin.version}.tgz`,
    )
    expect(pin.registry.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/)
    expect(Object.keys(pin.artifacts).sort()).toEqual([
      'opencascade.wasm.js',
      'opencascade.wasm.wasm',
    ])
    for (const digest of Object.values(pin.artifacts)) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('the source mirror pins the same OCCT commit as the version pin', () => {
    const mirror = readFileSync(join(ROOT, 'frontend', 'scripts', 'fetchOccSource.mjs'), 'utf8')
    expect(mirror).toContain(pin.occt.commit)
    expect(mirror).toContain(`V${pin.occt.version.replace(/\./g, '_')}`)
  })
})
