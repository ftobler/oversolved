// The generated input for a slim opencascade.js build: occ.used.json lists the
// OCCT bindings the app touches, derived from occTypes.ts plus every `oc.` /
// `occ.` access in src/. The list must not drift from the code: the check test
// below fails when a new access is not in the file (the slim build would then
// drop a binding the app calls), and the fixture cases drive both directions
// plus the emscripten-runtime split without needing a real build.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(FRONTEND, 'scripts', 'occUsage.mjs')

interface Run {
  status: number
  stdout: string
  stderr: string
}

function run(args: string[], cwd = FRONTEND): Run {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8' })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

// A miniature source tree: occTypes.ts declaring the embind surface and one
// code file making accesses, the two inputs scanUsage reads.
function makeFixture(
  root: string,
  options: { declared?: string[]; code?: string } = {},
): { src: string; out: string } {
  const src = join(root, 'src')
  const occDir = join(src, 'kernel', 'occ')
  mkdirSync(occDir, { recursive: true })
  const declared = options.declared ?? []
  writeFileSync(
    join(occDir, 'occTypes.ts'),
    `export interface OccModule extends OccBaseModule {\n` +
      declared.map(name => `  ${name}: unknown\n`).join('') +
      `}\n`,
  )
  writeFileSync(join(src, 'app.ts'), options.code ?? '')
  return { src, out: join(root, 'occ.used.json') }
}

function readUsed(out: string): { symbols: string[]; runtime: string[] } {
  return JSON.parse(readFileSync(out, 'utf8'))
}

describe('occUsage', () => {
  let workDir: string

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'occUsage-'))
  })

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it('the committed occ.used.json is current with the real tree', () => {
    const result = run(['--check'])
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('the committed list covers the bindings the kernel builds on', () => {
    const used = readUsed(join(FRONTEND, 'occ.used.json'))
    for (const symbol of ['BRepPrimAPI_MakeBox', 'TopoDS', 'BRepGProp', 'gp_Pnt']) {
      expect(used.symbols).toContain(symbol)
    }
    // Emscripten members are recorded apart from OCCT bindings: they come from
    // build flags, not from the binding generator.
    expect(used.runtime).toContain('FS')
    expect(used.symbols).not.toContain('FS')
  })

  it('fails when code accesses a binding missing from the list', () => {
    const { src, out } = makeFixture(join(workDir, 'missing'), {
      declared: ['gp_Pnt_3'],
      code: 'const a = new oc.gp_Pnt_3(0, 0, 0)\n',
    })
    expect(run(['generate', '--src', src, '--out', out]).status).toBe(0)

    // The new access arrives after the list was generated: exactly the drift a
    // slim build would ship as a missing binding.
    writeFileSync(join(src, 'app.ts'), 'const a = new oc.gp_Pnt_3(0, 0, 0)\nconst b = new oc.BRepPrimAPI_MakeBox_1(1, 1, 1)\n')
    const result = run(['check', '--src', src, '--out', out])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('used but missing from occ.used.json: BRepPrimAPI_MakeBox')
    expect(result.stderr).toContain('app.ts')
    expect(result.stderr).toContain('npm run occ:usage')
  })

  it('fails when the list keeps a binding nothing uses any more', () => {
    const { src, out } = makeFixture(join(workDir, 'stale'), {
      code: 'const a = new oc.gp_Pnt_3(0, 0, 0)\n',
    })
    expect(run(['generate', '--src', src, '--out', out]).status).toBe(0)

    writeFileSync(join(src, 'app.ts'), '')
    const result = run(['check', '--src', src, '--out', out])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('listed but no longer used: gp_Pnt')
  })

  it('overload suffixes collapse to one binding and declared members are kept', () => {
    const { src, out } = makeFixture(join(workDir, 'collapse'), {
      declared: ['BRep_Tool', 'gp_Ax2_3'],
      code: [
        'oc.BRepPrimAPI_MakeBox_1(1, 1, 1)',
        'oc.BRepPrimAPI_MakeBox_2(p, 1, 1, 1)',
        'oc.gp_Dir_4(0, 0, 1)',
        '',
      ].join('\n'),
    })
    expect(run(['generate', '--src', src, '--out', out]).status).toBe(0)
    const used = readUsed(out)
    // The declared surface is kept even without a current call site, so a slim
    // build keeps the bindings occTypes.ts promises the kernel.
    expect(used.symbols).toEqual(['BRepPrimAPI_MakeBox', 'BRep_Tool', 'gp_Ax2', 'gp_Dir'])
  })

  it('records emscripten members in the runtime list, not as bindings', () => {
    const { src, out } = makeFixture(join(workDir, 'runtime'), {
      code: 'occ.FS.readFile("/a")\noc.HEAP32[x]\noc.UTF8ToString(0)\n',
    })
    expect(run(['generate', '--src', src, '--out', out]).status).toBe(0)
    const used = readUsed(out)
    expect(used.symbols).toEqual([])
    expect(used.runtime).toEqual(['FS', 'HEAP32', 'UTF8ToString'])
  })

  it('ignores lowercase properties and text in prose', () => {
    const { src, out } = makeFixture(join(workDir, 'prose'), {
      code: [
        '// occ.pin.json stays prose, occ.load is the memoized loader',
        "const name = 'occ.pin.json'",
        'occ.load()',
        'occ.pin.version',
        '',
      ].join('\n'),
    })
    expect(run(['generate', '--src', src, '--out', out]).status).toBe(0)
    const used = readUsed(out)
    expect(used.symbols).toEqual([])
    expect(used.runtime).toEqual([])
  })

  it('regeneration is byte-stable', () => {
    const { src, out } = makeFixture(join(workDir, 'stable'), {
      declared: ['gp_Pnt_3'],
      code: 'oc.TopExp_Explorer_2(x, e, e)\noc.gp_Vec_4(1, 2, 3)\n',
    })
    expect(run(['generate', '--src', src, '--out', out]).status).toBe(0)
    const first = readFileSync(out, 'utf8')
    expect(run(['generate', '--src', src, '--out', out]).status).toBe(0)
    expect(readFileSync(out, 'utf8')).toBe(first)
  })

  it('symbols prints the build allowlist, one per line', () => {
    const { src, out } = makeFixture(join(workDir, 'symbols'), {
      declared: ['BRep_Tool'],
      code: 'oc.gp_Pnt_3(0, 0, 0)\nocc.FS.readFile("/a")\n',
    })
    expect(run(['generate', '--src', src, '--out', out]).status).toBe(0)
    const result = run(['symbols', '--src', src, '--out', out])
    expect(result.status).toBe(0)
    expect(result.stdout.trim().split('\n')).toEqual(['BRep_Tool', 'gp_Pnt'])
  })
})
