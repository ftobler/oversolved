// The regression corpus contract, checked without a kernel: every case
// directory has exactly the expected files, its recipe loads through the one
// part loader, its checks.json is valid and its licence is on the allow list,
// `snapshot: true` matches a present snapshot, an exception names a real recipe
// feature, and the migrated real_doc labels appear in no second corpus.

import { describe, it, expect, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadPartDocText } from '@/persistence/docSchema'
import { partSpecFromText } from '@/utils/partExport'
import {
  isKebabCase,
  LICENSE_ALLOW_LIST,
  listRegressionCases,
  listRegressionDirs,
  loadRegressionCase,
  parseChecks,
  parseSnapshot,
  REGRESSION_CASE_FILES,
  REGRESSIONS_DIR,
} from '../corpus'
import { recipeFeatureIds, regressionFailureIsSoft } from '../run'

mkdirSync(join(process.cwd(), 'tmp'), { recursive: true })
const workDir = mkdtempSync(join(process.cwd(), 'tmp', 'regressions-meta-'))

afterAll(() => rmSync(workDir, { recursive: true, force: true }))

const RECIPE = [
  'kind: part',
  'version: 3',
  'features:',
  '  - id: sk1',
  '    kind: sketch',
  '    plane: "@builtin_plane_front"',
  '    entities:',
  '      - id: c1',
  '        kind: circle',
  '    initial:',
  '      c1:',
  '        - 0',
  '        - 0',
  '        - 5',
  '',
].join('\n')

const VALID_CHECKS = {
  origin: { kind: 'bug_report', ref: 'test', date: '2026-10-22' },
  license: 'own',
  severity: 'hard',
  what: 'a fixture case',
  features: { default: 'ok' },
  tolerance: { rel: 1e-6, abs: 1e-6 },
  topology: 'strict',
  measures: {
    bodies: 0,
    volume: 0,
    area: 0,
    centroid: null,
    bbox: null,
    faces: 0,
    edges: 0,
  },
  snapshot: false,
}

const VALID_SNAPSHOT = {
  bodies: {
    body_1: {
      created_by: 'ex1',
      modified_by: [],
      face_hashes: ['gface_a', 'gface_b'],
      edge_hashes: ['gedge_a'],
    },
  },
}

/** Write one fixture case; any file left out is absent. */
function writeCase(
  root: string,
  name: string,
  options: { recipe?: string | null; checks?: unknown; snapshot?: unknown; extra?: string } = {},
): void {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  if (options.recipe !== null) writeFileSync(join(dir, 'recipe.yaml'), options.recipe ?? RECIPE)
  if (options.checks !== undefined) writeFileSync(join(dir, 'checks.json'), JSON.stringify(options.checks, null, 2))
  if (options.snapshot !== undefined) writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(options.snapshot, null, 2))
  if (options.extra !== undefined) writeFileSync(join(dir, options.extra), 'stray\n')
}

/** Files in a case directory beyond the three the format allows, plus missing required ones. */
function layoutProblems(name: string, dir = REGRESSIONS_DIR): string[] {
  const files = readdirSync(join(dir, name)).sort()
  const problems = files
    .filter((file) => !(REGRESSION_CASE_FILES as readonly string[]).includes(file))
    .map((file) => `${name}: stray file ${file}`)
  for (const required of ['recipe.yaml', 'checks.json']) {
    if (!files.includes(required)) problems.push(`${name}: missing ${required}`)
  }
  return problems
}

describe('regression corpus meta', () => {
  const cases = listRegressionCases()

  it('loads the real corpus', () => {
    expect(listRegressionDirs()).toContain('two-rings')
    expect(cases.map((c) => c.name)).toContain('two-rings')
    expect(cases.map((c) => c.name)).toContain('real-angular')
  })

  it('kebab-cases every directory name', () => {
    for (const name of listRegressionDirs()) {
      expect(isKebabCase(name), `case name ${JSON.stringify(name)} is not kebab-case`).toBe(true)
    }
  })

  it('has exactly recipe.yaml, checks.json and an optional snapshot.json per case', () => {
    for (const name of listRegressionDirs()) {
      expect(layoutProblems(name), `${name}: unexpected case layout`).toEqual([])
    }
  })

  it('rejects a stray file in a case directory', () => {
    const root = join(workDir, 'stray-file')
    writeCase(root, 'stray-case', { checks: VALID_CHECKS, extra: 'notes.txt' })
    expect(layoutProblems('stray-case', root)).toEqual(['stray-case: stray file notes.txt'])
  })

  it('loads every case recipe through the one part loader', () => {
    for (const regressionCase of cases) {
      const loaded = loadPartDocText(regressionCase.recipe)
      expect(loaded.ok, `${regressionCase.name}: ${loaded.ok ? '' : loaded.error.field}`).toBe(true)
      const doc = partSpecFromText(regressionCase.recipe)
      expect(Array.isArray(doc.features), `${regressionCase.name}: features`).toBe(true)
      const ids = recipeFeatureIds(doc)
      // Re-parse with the recipe's ids so `features.except` is cross-checked.
      expect(() => parseChecks(regressionCase.name, JSON.stringify(regressionCase.checks), ids)).not.toThrow()
      if (regressionCase.snapshot !== null) {
        for (const [bodyId, body] of Object.entries(regressionCase.snapshot.bodies)) {
          expect(body.face_hashes, `${regressionCase.name}/${bodyId}/face_hashes sorted`)
            .toEqual([...body.face_hashes].sort())
          expect(body.edge_hashes, `${regressionCase.name}/${bodyId}/edge_hashes sorted`)
            .toEqual([...body.edge_hashes].sort())
          expect(body.modified_by, `${regressionCase.name}/${bodyId}/modified_by sorted`)
            .toEqual([...body.modified_by].sort())
        }
      }
    }
  })

  it('rejects a case directory with no recipe.yaml', () => {
    const root = join(workDir, 'no-recipe')
    writeCase(root, 'broken-case', { recipe: null, checks: VALID_CHECKS })
    expect(() => loadRegressionCase('broken-case', root)).toThrow(/recipe\.yaml/)
  })

  it('rejects a case directory with no checks.json', () => {
    const root = join(workDir, 'no-checks')
    writeCase(root, 'broken-case')
    expect(() => loadRegressionCase('broken-case', root)).toThrow(/checks\.json/)
  })

  it('rejects a non-kebab-case case name', () => {
    const root = join(workDir, 'bad-name')
    writeCase(root, '01_broken', { checks: VALID_CHECKS })
    expect(() => loadRegressionCase('01_broken', root)).toThrow(/kebab-case/)
  })

  it('rejects a licence outside the allow list, naming the case and the list', () => {
    const root = join(workDir, 'bad-license')
    writeCase(root, 'bad-license-case', { checks: { ...VALID_CHECKS, license: 'LGPL-2.1' } })
    expect(() => loadRegressionCase('bad-license-case', root)).toThrow(/bad-license-case/)
    expect(() => loadRegressionCase('bad-license-case', root)).toThrow(/own, MIT, Apache-2\.0, BSD-2-Clause, BSD-3-Clause, CC0-1\.0/)
  })

  it('accepts each allowed licence', () => {
    for (const spdx of LICENSE_ALLOW_LIST) {
      const license = spdx === 'own' ? 'own' : { spdx, source: 'https://example.test/model', commit: 'abc123' }
      const root = join(workDir, `license-${spdx.replace(/\./g, '-')}`)
      writeCase(root, 'license-case', { checks: { ...VALID_CHECKS, license } })
      expect(() => loadRegressionCase('license-case', root)).not.toThrow()
    }
  })

  it('rejects a third-party licence without source and commit', () => {
    expect(() => parseChecks('broken-case', JSON.stringify({ ...VALID_CHECKS, license: { spdx: 'MIT' } })))
      .toThrow(/source/)
  })

  it('ties snapshot: true to a present snapshot.json in both directions', () => {
    const missing = join(workDir, 'snapshot-missing')
    writeCase(missing, 'snapshot-case', { checks: { ...VALID_CHECKS, snapshot: true } })
    expect(() => loadRegressionCase('snapshot-case', missing)).toThrow(/snapshot\.json: missing/)

    const stray = join(workDir, 'snapshot-stray')
    writeCase(stray, 'snapshot-case', { checks: VALID_CHECKS, snapshot: VALID_SNAPSHOT })
    expect(() => loadRegressionCase('snapshot-case', stray)).toThrow(/snapshot\.json: present/)
  })

  it('rejects an unknown features.except id', () => {
    const checks = {
      ...VALID_CHECKS,
      features: { default: 'ok', except: { no_such_feature: 'exception' } },
    }
    expect(() => parseChecks('broken-case', JSON.stringify(checks), ['sk1'])).toThrow(/unknown feature id/)
  })

  it('rejects an unknown checks key or measure name', () => {
    expect(() => parseChecks('broken-case', JSON.stringify({ ...VALID_CHECKS, snasphot: true })))
      .toThrow(/unknown field/)
    expect(() => parseChecks('broken-case', JSON.stringify({
      ...VALID_CHECKS,
      measures: { bodies: 0, voume: 1 },
    }))).toThrow(/unknown field/)
  })

  it('keeps optional measures optional and accepts null centroid and bbox', () => {
    const parsed = parseChecks('ok-case', JSON.stringify({
      ...VALID_CHECKS,
      measures: { bodies: 0, centroid: null, bbox: null },
    }))
    expect(parsed.measures).toEqual({ bodies: 0, centroid: null, bbox: null })
  })

  it('rejects a malformed snapshot body', () => {
    expect(() => parseSnapshot('broken-case', JSON.stringify({
      bodies: { body_1: { created_by: 'ex1', modified_by: [], face_hashes: [] } },
    }))).toThrow(/edge_hashes/)
  })

  it('treats soft cases as warnings and hard cases as failures unless REGRESSION_SOFT=1', () => {
    expect(regressionFailureIsSoft('soft', false)).toBe(true)
    expect(regressionFailureIsSoft('hard', false)).toBe(false)
    expect(regressionFailureIsSoft('hard', true)).toBe(true)
  })
})

describe('migrated real_doc entries', () => {
  // The 15 anchors moved from the baseline blob to folder cases. They must not
  // be double-covered: the manifest and baseline are the curated corpus now.
  const LABELS = [
    'real_angular',
    'real_angular_Clone',
    'real_cylinder',
    'real_cylinder_Clone',
    'real_cylinder_Clone_Clone',
    'real_dimensions',
    'real_melted',
    'real_querytest',
    'real_querytest2',
    'real_querytest3',
    'real_split',
    'real_star',
    'real_translate',
    'real_two_objects_1',
    'real_two_objects_2',
  ]

  const baseline = JSON.parse(
    readFileSync(join(REGRESSIONS_DIR, '..', 'src', 'wasm-kernel', 'regression-baseline.json'), 'utf8'),
  ) as Array<{ label: string }>
  const manifest = JSON.parse(
    readFileSync(join(REGRESSIONS_DIR, '..', 'src', 'wasm-kernel', 'corpus-manifest.json'), 'utf8'),
  ) as { cases: Record<string, unknown>; summary: { total: number } }

  it('keeps the numbered labels in neither the baseline nor the manifest', () => {
    const baselineLabels = baseline.map((entry) => entry.label)
    for (const label of LABELS) {
      expect(baselineLabels, `${label} still in regression-baseline.json`).not.toContain(label)
      expect(manifest.cases, `${label} still in corpus-manifest.json`).not.toHaveProperty([label])
    }
  })

  it('has a folder case for each migrated label and leaves 55 curated entries', () => {
    const dirs = listRegressionDirs()
    for (const label of LABELS) {
      expect(dirs, `${label} has no folder case`).toContain(label.toLowerCase().replace(/_/g, '-'))
    }
    expect(baseline.length).toBe(55)
    expect(manifest.summary.total).toBe(55)
  })
})
