// Vitest 3's worker RPC client carries birpc's hard-coded 60 s call timeout.
// A loaded CI host can answer an `onTaskUpdate` after it, so the worker preload
// doubles the bundled constant. Drive the real loader in a child process
// against the installed chunk, and keep the path filter honest with an
// unrelated fixture.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REGISTER = join(FRONTEND, 'scripts', 'vitestRpcTimeout.register.mjs')
const BUNDLED_TIMEOUT = 'const DEFAULT_TIMEOUT = 6e4;'
const require = createRequire(import.meta.url)

function findBundledChunk(root: string): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findBundledChunk(path)
      if (found !== undefined) return found
    } else if (entry.name.endsWith('.js') && readFileSync(path, 'utf8').includes(BUNDLED_TIMEOUT)) {
      return path
    }
  }
  return undefined
}

describe('vitest rpc timeout preload', () => {
  let workDir = ''

  beforeAll(() => {
    const tmpRoot = join(FRONTEND, '..', 'tmp')
    mkdirSync(tmpRoot, { recursive: true })
    workDir = mkdtempSync(join(tmpRoot, 'vitest-rpc-timeout-'))
  })

  afterAll(() => {
    if (workDir !== '') rmSync(workDir, { recursive: true, force: true })
  })

  function runChild(args: string[]): string {
    return execFileSync(process.execPath, ['--import', REGISTER, ...args], {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim()
  }

  function runFixture(relativePath: string): string {
    const file = join(workDir, relativePath)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${BUNDLED_TIMEOUT}\nconsole.log(DEFAULT_TIMEOUT)\n`)
    return runChild([file])
  }

  it('doubles the timeout in the installed vitest chunk', () => {
    const vitestRoot = dirname(require.resolve('vitest/package.json'))
    const chunk = findBundledChunk(join(vitestRoot, 'dist'))
    if (chunk === undefined) throw new Error('vitest no longer carries birpc DEFAULT_TIMEOUT; remove the preload')

    const probe = join(workDir, 'probe.mjs')
    writeFileSync(probe, `
const delays = []
globalThis.setTimeout = (_fn, ms) => { delays.push(ms); return 0 }
const { c: createBirpc } = await import(${JSON.stringify(pathToFileURL(chunk).href)})
const rpc = createBirpc({}, { post() {}, on() { return () => {} } })
rpc.neverResponds()
await new Promise(resolve => process.nextTick(resolve))
console.log(delays[0] ?? 0)
`)
    expect(runChild([probe])).toBe('120000')
  })

  it('leaves a module outside vitest alone', () => {
    expect(runFixture('src/index.fixture.mjs')).toBe('60000')
  })

  it('is registered in this vitest worker', () => {
    expect(process.execArgv).toContain('--import')
    expect(process.execArgv).toContain(pathToFileURL(REGISTER).href)
  })
})
