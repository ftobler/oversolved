// The install path for the OCC artifact: occ:install and occ:provision both run
// scripts/occProvision.mjs, which verifies the exact version, the OCCT version
// the build declares, and a sha256 for each dist file against occ.pin.json.
// Provisioning must refuse bytes that do not match, so a replaced or corrupt
// artifact can never reach public/occ unnoticed.
//
// The mismatch cases run against temp dirs whose digests the test computes, so
// they need no real artifact. The happy path runs against the real install when
// it is present and skips otherwise, mirroring the gated OCC Real tests.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(FRONTEND, 'scripts', 'occProvision.mjs')
const REAL_PACKAGE = join(FRONTEND, 'node_modules', 'opencascade.js')

const realPin = JSON.parse(readFileSync(join(FRONTEND, 'occ.pin.json'), 'utf8'))

interface Run {
  status: number
  stdout: string
  stderr: string
}

function run(args: string[]): Run {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], { cwd: FRONTEND, encoding: 'utf8' })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// A miniature opencascade.js install: only the shapes the verifier reads.
function makeFakePackage(dir: string, overrides: { version?: string; occt?: string } = {}): Record<string, string> {
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'opencascade.js', version: overrides.version ?? '1.1.1' }),
  )
  writeFileSync(
    join(dir, 'README.md'),
    `Current OCCT version: [V${(overrides.occt ?? '7_4_0p1').replace(/\./g, '_')}](https://example.invalid)\n`,
  )
  const files: Record<string, string> = {}
  for (const name of Object.keys(realPin.artifacts)) {
    const body = `fake ${name} bytes`
    writeFileSync(join(dir, 'dist', name), body)
    files[name] = sha256(body)
  }
  return files
}

function fakePin(artifacts: Record<string, string>): string {
  return JSON.stringify({
    package: 'opencascade.js',
    version: '1.1.1',
    occt: { version: '7.4.0p1' },
    artifacts,
  })
}

describe('occProvision', () => {
  let workDir: string

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'occProvision-'))
  })

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it.skipIf(!existsSync(join(REAL_PACKAGE, 'dist')))(
    'verifies the real opencascade.js install against the committed pin',
    () => {
      const result = run(['verify'])
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`verified opencascade.js@${realPin.version}`)
    },
  )

  it('accepts a matching package dir and pin', () => {
    const pkg = join(workDir, 'ok-pkg')
    const pinPath = join(workDir, 'ok-pin.json')
    writeFileSync(pinPath, fakePin(makeFakePackage(pkg)))
    const result = run(['verify', '--package-dir', pkg, '--pin', pinPath])
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('rejects a digest that does not match the pin', () => {
    const pkg = join(workDir, 'bad-digest-pkg')
    const pinPath = join(workDir, 'bad-digest-pin.json')
    const files = makeFakePackage(pkg)
    files['opencascade.wasm.wasm'] = '0'.repeat(64)
    writeFileSync(pinPath, fakePin(files))
    const result = run(['verify', '--package-dir', pkg, '--pin', pinPath])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('sha256')
    expect(result.stderr).toContain('opencascade.wasm.wasm')
  })

  it('rejects a package version that drifted from the pin', () => {
    const pkg = join(workDir, 'bad-version-pkg')
    const pinPath = join(workDir, 'bad-version-pin.json')
    writeFileSync(pinPath, fakePin(makeFakePackage(pkg, { version: '1.2.0' })))
    const result = run(['verify', '--package-dir', pkg, '--pin', pinPath])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('does not match the pin')
  })

  it('rejects a build whose declared OCCT version differs from the pin', () => {
    const pkg = join(workDir, 'bad-occt-pkg')
    const pinPath = join(workDir, 'bad-occt-pin.json')
    writeFileSync(pinPath, fakePin(makeFakePackage(pkg, { occt: '7.5.0' })))
    const result = run(['verify', '--package-dir', pkg, '--pin', pinPath])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('declares OCCT 7.5.0')
  })

  it('refuses to provision a mismatching artifact', () => {
    const pkg = join(workDir, 'refuse-pkg')
    const pinPath = join(workDir, 'refuse-pin.json')
    const outDir = join(workDir, 'refuse-out')
    const files = makeFakePackage(pkg)
    files['opencascade.wasm.js'] = 'f'.repeat(64)
    writeFileSync(pinPath, fakePin(files))
    const result = run(['provision', '--package-dir', pkg, '--out-dir', outDir, '--pin', pinPath])
    expect(result.status).not.toBe(0)
    expect(existsSync(outDir)).toBe(false)
  })

  it('provisions every pinned artifact once verified', () => {
    const pkg = join(workDir, 'copy-pkg')
    const pinPath = join(workDir, 'copy-pin.json')
    const outDir = join(workDir, 'copy-out')
    writeFileSync(pinPath, fakePin(makeFakePackage(pkg)))
    const result = run(['provision', '--package-dir', pkg, '--out-dir', outDir, '--pin', pinPath])
    expect(result.status).toBe(0)
    for (const name of Object.keys(realPin.artifacts)) {
      expect(readFileSync(join(outDir, name), 'utf8')).toBe(`fake ${name} bytes`)
    }
  })
})
