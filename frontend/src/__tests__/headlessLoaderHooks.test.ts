// @vitest-environment node
//
// The headless entries (drive CLI, MCP server, the forked watchdog children)
// load the source tree through module hooks. The off-thread `--loader` form
// cost a blocking cross-thread round trip per module, ~1.2 s of every spawn,
// so the hooks now register in-thread through scripts/*.register.mjs. Each
// hook exists in an async and a sync form; these tests keep the two forms in
// agreement, run one real child through the register entry, and keep the
// off-thread flag from creeping back into the entry points.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

type Resolved = { url: string }
type NextResolve = (specifier: string) => Resolved | Promise<Resolved>
type Loaded = { format: string; source: string }
type NextLoad = (url: string) => Loaded | Promise<Loaded>

interface DriveLoader {
  resolve(specifier: string, context: object, next: NextResolve): Promise<Resolved>
  resolveSync(specifier: string, context: object, next: NextResolve): Resolved
  load(url: string, context: object, next: NextLoad): Promise<Loaded>
  loadSync(url: string, context: object, next: NextLoad): Loaded
}

let loader: DriveLoader
beforeAll(async () => {
  loader = await import(pathToFileURL(join(FRONTEND, 'scripts', 'driveCli.loader.mjs')).href) as DriveLoader
})

// A resolver that only knows the given specifiers and records every attempt,
// so both forms can be checked for the same walk, not just the same answer.
function fakeResolver(known: string[]) {
  const tried: string[] = []
  const sync = (specifier: string): Resolved => {
    tried.push(specifier)
    if (known.includes(specifier)) return { url: `file://${specifier}` }
    throw new Error(`cannot resolve ${specifier}`)
  }
  return { tried, sync, async: async (specifier: string) => sync(specifier) }
}

async function bothForms(specifier: string, known: string[]) {
  const a = fakeResolver(known)
  const s = fakeResolver(known)
  const asyncResult = await loader.resolve(specifier, {}, a.async).catch((e: Error) => e.message)
  let syncResult: Resolved | string
  try { syncResult = loader.resolveSync(specifier, {}, s.sync) } catch (e) { syncResult = (e as Error).message }
  return { asyncResult, syncResult, asyncTried: a.tried, syncTried: s.tried }
}

describe('the alias resolver, async and sync forms', () => {
  it('maps @/ onto src and adds .ts the same way in both forms', async () => {
    const aliased = join(FRONTEND, 'src', 'kernel', 'evalExpr')
    const r = await bothForms('@/kernel/evalExpr', [aliased + '.ts'])
    expect(r.syncResult).toEqual({ url: `file://${aliased}.ts` })
    expect(r.asyncResult).toEqual(r.syncResult)
    expect(r.syncTried).toEqual([aliased, '@/kernel/evalExpr', aliased + '.ts'])
    expect(r.asyncTried).toEqual(r.syncTried)
  })

  it('falls back to a directory index.ts', async () => {
    // The fallback checks the disk, so this must be a real directory with one.
    const dir = join(FRONTEND, 'src', 'registry')
    const r = await bothForms(dir, [join(dir, 'index.ts')])
    expect(r.syncResult).toEqual({ url: `file://${join(dir, 'index.ts')}` })
    expect(r.asyncResult).toEqual(r.syncResult)
    expect(r.asyncTried).toEqual(r.syncTried)
  })

  it('reports the first failure when nothing resolves', async () => {
    const r = await bothForms('./nowhere', [])
    expect(r.syncResult).toBe('cannot resolve ./nowhere')
    expect(r.asyncResult).toBe(r.syncResult)
  })
})

describe('the import.meta.env shim, async and sync forms', () => {
  const source = 'export const dev = import.meta.env.DEV\n'
  const next = (): Loaded => ({ format: 'module-typescript', source })

  it('rewrites the app sources identically in both forms', async () => {
    const url = 'file:///repo/frontend/src/kernel/a.ts'
    const sync = loader.loadSync(url, {}, next)
    expect(sync.source).not.toContain('import.meta.env')
    expect(sync.source).toContain('DEV: false')
    expect(await loader.load(url, {}, async () => next())).toEqual(sync)
  })

  it('leaves node_modules untouched, even a package src/ folder', () => {
    for (const url of ['file:///repo/frontend/node_modules/pkg/index.ts', 'file:///repo/frontend/node_modules/pkg/src/a.ts']) {
      expect(loader.loadSync(url, {}, next).source, url).toBe(source)
    }
  })
})

describe('the in-thread registration', () => {
  let workDir = ''
  beforeAll(() => {
    const tmpRoot = join(FRONTEND, '..', 'tmp')
    mkdirSync(tmpRoot, { recursive: true })
    workDir = mkdtempSync(join(tmpRoot, 'headless-hooks-'))
  })
  afterAll(() => { rmSync(workDir, { recursive: true, force: true }) })

  it('runs a source-tree import through the drive register entry', () => {
    const probe = join(workDir, 'probe.ts')
    writeFileSync(probe, "import { evalExpr } from '@/kernel/evalExpr'\nconsole.log(JSON.stringify(evalExpr('2 * 3 + 1')))\n")
    const out = execFileSync('node', [
      '--experimental-strip-types', '--no-warnings', '--import=./scripts/driveCli.register.mjs', probe,
    ], { cwd: FRONTEND, encoding: 'utf8' })
    expect(JSON.parse(out.trim())).toBe(7)
  })
})

describe('the headless entry points', () => {
  it('start through the register entries, never the off-thread --loader flag', () => {
    const scripts = (JSON.parse(readFileSync(join(FRONTEND, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    const mcp = readFileSync(join(FRONTEND, '..', '.mcp.json'), 'utf8')
    for (const name of ['drive', 'mcp', 'regressions:add', 'regressions:regen', 'regen:corpus']) {
      expect(scripts[name], name).toMatch(/--import=\.\/scripts\/\w+\.register\.mjs/)
      expect(scripts[name], name).not.toContain('--loader')
    }
    expect(mcp).toContain('--import=./frontend/scripts/driveCli.register.mjs')
    expect(mcp).not.toContain('--loader')
  })
})
