// The translation corpus contract, checked without a kernel: the real corpus
// loads, and a case missing its recipe or reference, naming a source file that
// does not exist, omitting tolerance, or stating an unknown topology is a named
// error rather than a silent pass.

import { describe, it, expect, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listTranslationCases,
  listTranslationDirs,
  loadTranslationCase,
  parseReference,
} from '../corpus'

const workDir = mkdtempSync(join(tmpdir(), 'translations-meta-'))

afterAll(() => rmSync(workDir, { recursive: true, force: true }))

const VALID_REFERENCE = {
  source: { tool: 'test', version: '1', file: 'source.md' },
  tolerance: { rel: 1e-6, abs: 1e-6 },
  bodies: 1,
  volume: 1,
  area: 1,
  centroid: [0, 0, 0],
  bbox: [0, 0, 0, 1, 1, 1],
  faces: 6,
  edges: 12,
}

/** Write one fixture case under `root`; any field left out is simply absent. */
function writeCase(root: string, name: string, options: { recipe?: boolean; reference?: unknown; source?: boolean } = {}): void {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  if (options.recipe !== false) writeFileSync(join(dir, 'recipe.yaml'), 'kind: part\nfeatures: []\n')
  if (options.source !== false) writeFileSync(join(dir, 'source.md'), '# source\n')
  if (options.reference !== undefined) writeFileSync(join(dir, 'reference.json'), JSON.stringify(options.reference, null, 1))
}

describe('translation corpus meta', () => {
  const cases = listTranslationCases()

  it('loads the real corpus', () => {
    expect(listTranslationDirs()).toContain('01-cylinder')
    expect(cases.map((c) => c.name)).toContain('01-cylinder')
    const seed = cases.find((c) => c.name === '01-cylinder')!
    expect(seed.reference.source.tool).toBe('analytic')
    expect(seed.reference.topology).toBe('report')
    expect(seed.reference.tolerance).toEqual({ rel: 1e-6, abs: 1e-6 })
  })

  it('rejects a case directory with no recipe.yaml', () => {
    const root = join(workDir, 'no-recipe')
    writeCase(root, '01-broken', { recipe: false, reference: VALID_REFERENCE })
    expect(() => loadTranslationCase('01-broken', root)).toThrow(/recipe\.yaml/)
  })

  it('rejects a case directory with no reference.json', () => {
    const root = join(workDir, 'no-reference')
    writeCase(root, '01-broken')
    expect(() => loadTranslationCase('01-broken', root)).toThrow(/reference\.json/)
  })

  it('rejects a reference naming a source.file that does not exist', () => {
    const root = join(workDir, 'no-source')
    writeCase(root, '01-broken', { reference: VALID_REFERENCE, source: false })
    expect(() => loadTranslationCase('01-broken', root)).toThrow(/source\.file "source\.md"/)
  })

  it('rejects a source.file with a .. segment even when the file exists', () => {
    const root = join(workDir, 'escape-relative')
    writeCase(root, '01-broken', {
      reference: { ...VALID_REFERENCE, source: { ...VALID_REFERENCE.source, file: '../outside.md' } },
    })
    writeFileSync(join(root, 'outside.md'), '# outside\n')
    expect(() => loadTranslationCase('01-broken', root)).toThrow(/must stay inside the case directory/)
  })

  it('rejects an absolute source.file before checking whether it exists', () => {
    const root = join(workDir, 'escape-absolute')
    writeCase(root, '01-broken', {
      reference: { ...VALID_REFERENCE, source: { ...VALID_REFERENCE.source, file: '/etc/passwd' } },
    })
    expect(() => loadTranslationCase('01-broken', root)).toThrow(/must stay inside the case directory/)
  })

  it('rejects a reference without tolerance', () => {
    const noTolerance = { ...VALID_REFERENCE } as Record<string, unknown>
    delete noTolerance.tolerance
    expect(() => parseReference('01-broken', JSON.stringify(noTolerance))).toThrow(/tolerance/)
  })

  it('rejects an unknown or explicit-null topology value', () => {
    expect(() => parseReference('01-broken', JSON.stringify({ ...VALID_REFERENCE, topology: 'loose' }))).toThrow(/topology/)
    expect(() => parseReference('01-broken', JSON.stringify({ ...VALID_REFERENCE, topology: null }))).toThrow(/topology/)
  })

  it('rejects a fractional or negative face or edge count', () => {
    expect(() => parseReference('01-broken', JSON.stringify({ ...VALID_REFERENCE, faces: 1.5 })))
      .toThrow(/faces: must be a non-negative integer/)
    expect(() => parseReference('01-broken', JSON.stringify({ ...VALID_REFERENCE, edges: -1 })))
      .toThrow(/edges: must be a non-negative integer/)
  })

  it('names the nested-measures mistake instead of the missing bodies field', () => {
    const { source, tolerance, volume, area, centroid, bbox } = VALID_REFERENCE
    const nested = {
      source,
      tolerance,
      measures: { bodies: 1, volume, area, centroid, bbox },
    }
    expect(() => parseReference('01-broken', JSON.stringify(nested)))
      .toThrow(/measures go at the top level of the reference, not under `measures`/)
  })

  it('defaults topology to report and keeps optional faces and edges', () => {
    const parsed = parseReference('01-broken', JSON.stringify(VALID_REFERENCE))
    expect(parsed.topology).toBe('report')
    expect(parsed.faces).toBe(6)
    expect(parsed.edges).toBe(12)
  })
})
