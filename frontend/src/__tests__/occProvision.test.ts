// The install path for the OCC artifact: `repin` writes frontend/occ.pin.json
// from an oversolved-occt release's manifest.json, `install` downloads the
// pinned files, and `verify`/`provision` check every file's sha256 and the
// manifest's OCCT version against the pin before anything reaches public/occ.
// Provisioning must refuse bytes that do not match, so a replaced or corrupt
// artifact can never be served unnoticed.
//
// Nothing here touches the network: the downloads run against a stubbed fetch,
// and the CLI cases run against temp dirs whose digests the test computes. The
// committed pin is checked against the real cache only when it is present.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  installOcc,
  occtVersionOfTag,
  pinFromManifest,
  provisionOcc,
  releaseUrl,
  verifyOccInstall,
} from '../../scripts/occProvision.mjs'

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(FRONTEND, 'scripts', 'occProvision.mjs')
const realPin = JSON.parse(readFileSync(join(FRONTEND, 'occ.pin.json'), 'utf8'))
const REAL_CACHE = join(FRONTEND, 'node_modules', '.occt', realPin.tag)

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

const FILES = ['occt.js', 'occt.wasm', 'LICENSE_LGPL_21.txt']

/** A release manifest whose digests match `body(name)`. */
function fakeManifest(occtTag = 'V8.0.1'): Record<string, unknown> {
  return {
    occt: {
      release: 'https://example.invalid/V8.0.1',
      tag: occtTag,
      commit: 'c'.repeat(40),
      archive: 'https://example.invalid/V8.0.1.tar.gz',
      sha256: 'a'.repeat(64),
      root: 'OCCT-8.0.1',
    },
    emcc: 'emcc 6.0.13',
    build_commit: 'b'.repeat(40),
    files: Object.fromEntries(FILES.map((name) => [name, sha256(part(name))])),
  }
}

function part(name: string): string {
  return `fake ${name} bytes`
}

/** A cache dir as `install` leaves it. */
function makeCache(dir: string, manifest = fakeManifest()): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  for (const name of FILES) writeFileSync(join(dir, name), part(name))
}

/** A fetch stub serving the fake release; `tamper` replaces one file's bytes. */
function fakeFetch(manifest: Record<string, unknown>, tamper?: string) {
  const asked: string[] = []
  const impl = async (url: string) => {
    asked.push(url)
    const name = url.split('/').pop() as string
    const text = name === 'manifest.json'
      ? JSON.stringify(manifest)
      : name === tamper ? 'tampered' : part(name)
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(text).buffer }
  }
  return { impl, asked }
}

describe('occProvision', () => {
  let workDir: string

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'occProvision-'))
  })

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it.skipIf(!existsSync(join(REAL_CACHE, 'manifest.json')))(
    'verifies the real download against the committed pin',
    () => {
      const result = run(['verify'])
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`verified ${realPin.tag}`)
    },
  )

  it('names the OCCT version a release tag carries', () => {
    expect(occtVersionOfTag('occt-8.0.1-r1')).toBe('8.0.1')
    expect(occtVersionOfTag('occt-8.0.1-r12')).toBe('8.0.1')
    expect(occtVersionOfTag('v8.0.1')).toBeUndefined()
  })

  it('repins from a manifest: tag, OCCT provenance and every digest', () => {
    const manifest = fakeManifest()
    const pin = pinFromManifest('someone/occt-build', 'occt-8.0.1-r2', manifest)
    expect(pin.repo).toBe('someone/occt-build')
    expect(pin.tag).toBe('occt-8.0.1-r2')
    expect(pin.occt).toMatchObject({ version: '8.0.1', tag: 'V8.0.1', commit: 'c'.repeat(40) })
    expect(pin.emcc).toBe('emcc 6.0.13')
    expect(pin.build_commit).toBe('b'.repeat(40))
    expect(pin.artifacts).toEqual(manifest.files)
  })

  it('refuses a release tag whose OCCT version disagrees with its manifest', () => {
    expect(() => pinFromManifest('r/o', 'occt-8.0.2-r1', fakeManifest())).toThrow(/names OCCT 8\.0\.2.*built 8\.0\.1/)
    expect(() => pinFromManifest('r/o', 'latest', fakeManifest())).toThrow(/occt-<version>-r<n>/)
  })

  it('refuses a manifest with a file that has no sha256', () => {
    const manifest = fakeManifest()
    ;(manifest.files as Record<string, string>)['occt.js'] = 'not-a-digest'
    expect(() => pinFromManifest('r/o', 'occt-8.0.1-r1', manifest)).toThrow(/occt\.js has no sha256/)
  })

  it('downloads every pinned file from the release and verifies it', async () => {
    const manifest = fakeManifest()
    const pin = pinFromManifest('r/o', 'occt-8.0.1-r1', manifest)
    const cache = join(workDir, 'install-ok')
    const { impl, asked } = fakeFetch(manifest)
    await installOcc(pin, cache, impl as never)
    expect(asked).toContain(releaseUrl('r/o', 'occt-8.0.1-r1', 'manifest.json'))
    expect(asked).toContain(releaseUrl('r/o', 'occt-8.0.1-r1', 'occt.wasm'))
    expect(verifyOccInstall(pin, cache)).toEqual([])
  })

  it('refuses a download whose bytes do not hash to the pin, and never writes it', async () => {
    const manifest = fakeManifest()
    const pin = pinFromManifest('r/o', 'occt-8.0.1-r1', manifest)
    const cache = join(workDir, 'install-tampered')
    const { impl } = fakeFetch(manifest, 'occt.wasm')
    await expect(installOcc(pin, cache, impl as never)).rejects.toThrow(/occt\.wasm .* sha256/)
    expect(existsSync(join(cache, 'occt.wasm'))).toBe(false)
  })

  it('skips a file the cache already holds verified', async () => {
    const manifest = fakeManifest()
    const pin = pinFromManifest('r/o', 'occt-8.0.1-r1', manifest)
    const cache = join(workDir, 'install-cached')
    makeCache(cache, manifest)
    const { impl, asked } = fakeFetch(manifest)
    await installOcc(pin, cache, impl as never)
    expect(asked.map((u) => u.split('/').pop())).toEqual(['manifest.json'])
  })

  it('rejects a digest that does not match the pin', () => {
    const cache = join(workDir, 'bad-digest')
    makeCache(cache)
    const pin = pinFromManifest('r/o', 'occt-8.0.1-r1', fakeManifest())
    pin.artifacts['occt.wasm'] = '0'.repeat(64)
    const pinPath = join(workDir, 'bad-digest-pin.json')
    writeFileSync(pinPath, JSON.stringify(pin))
    const result = run(['verify', '--cache-dir', cache, '--pin', pinPath])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('sha256')
    expect(result.stderr).toContain('occt.wasm')
  })

  it('rejects a download whose manifest names another OCCT version than the pin', () => {
    const cache = join(workDir, 'bad-occt')
    makeCache(cache, fakeManifest('V8.0.2'))
    const pin = pinFromManifest('r/o', 'occt-8.0.1-r1', fakeManifest())
    const pinPath = join(workDir, 'bad-occt-pin.json')
    writeFileSync(pinPath, JSON.stringify(pin))
    const result = run(['verify', '--cache-dir', cache, '--pin', pinPath])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('declares OCCT 8.0.2')
  })

  it('refuses to provision a mismatching artifact', () => {
    const cache = join(workDir, 'refuse')
    makeCache(cache)
    const pin = pinFromManifest('r/o', 'occt-8.0.1-r1', fakeManifest())
    pin.artifacts['occt.js'] = 'f'.repeat(64)
    const pinPath = join(workDir, 'refuse-pin.json')
    writeFileSync(pinPath, JSON.stringify(pin))
    const outDir = join(workDir, 'refuse-out')
    const result = run(['provision', '--cache-dir', cache, '--out-dir', outDir, '--pin', pinPath])
    expect(result.status).not.toBe(0)
    expect(existsSync(outDir)).toBe(false)
  })

  it('provisions every pinned artifact once verified, and drops a stale one', () => {
    const cache = join(workDir, 'copy')
    makeCache(cache)
    const pin = pinFromManifest('r/o', 'occt-8.0.1-r1', fakeManifest())
    const outDir = join(workDir, 'copy-out')
    mkdirSync(outDir, { recursive: true })
    // The previous build's files must not linger in the served directory.
    writeFileSync(join(outDir, 'opencascade.wasm.wasm'), 'old build')
    provisionOcc(pin, cache, outDir)
    expect(readdirSync(outDir).sort()).toEqual([...FILES].sort())
    for (const name of FILES) expect(readFileSync(join(outDir, name), 'utf8')).toBe(part(name))
  })

  it('accepts a shared symlink that already holds the pin, without writing through it', () => {
    const cache = join(workDir, 'link-match-cache')
    makeCache(cache)
    const pin = pinFromManifest('r/o', 'occt-8.0.1-r1', fakeManifest())
    const shared = join(workDir, 'link-match-shared')
    mkdirSync(shared, { recursive: true })
    for (const name of FILES) writeFileSync(join(shared, name), part(name))
    const outDir = join(workDir, 'link-match-out')
    symlinkSync(shared, outDir)
    provisionOcc(pin, cache, outDir)
    // The shared copy is settled, and nothing was dropped from it.
    expect(readdirSync(shared).sort()).toEqual([...FILES].sort())
  })

  it('refuses to write through a shared symlink that holds another build', () => {
    const cache = join(workDir, 'link-stale-cache')
    makeCache(cache)
    const pin = pinFromManifest('r/o', 'occt-8.0.1-r1', fakeManifest())
    const shared = join(workDir, 'link-stale-shared')
    mkdirSync(shared, { recursive: true })
    writeFileSync(join(shared, 'opencascade.wasm.wasm'), 'the other build')
    const outDir = join(workDir, 'link-stale-out')
    symlinkSync(shared, outDir)
    expect(() => provisionOcc(pin, cache, outDir)).toThrow(/symlink to a shared copy/)
    // The other tree's files are untouched.
    expect(readdirSync(shared)).toEqual(['opencascade.wasm.wasm'])
    expect(readFileSync(join(shared, 'opencascade.wasm.wasm'), 'utf8')).toBe('the other build')
  })
})
