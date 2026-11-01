// The corpus and report contract, checked without a kernel: every case
// directory carries recipe.yaml and a structurally valid expected.json with a
// non-empty method, every case appears in the generated docs/oracle.md, and
// the report names no case the corpus does not have. This is what makes a
// stale report fail even on an unprovisioned checkout.

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ORACLE_DIR, ORACLE_DOC_PATH, listOracleDirs, readOracleCase, type OracleCase } from '@/oracle/corpus'

function readAllCases(): { cases: OracleCase[]; errors: string[] } {
  const cases: OracleCase[] = []
  const errors: string[] = []
  for (const name of listOracleDirs()) {
    try {
      cases.push(readOracleCase(name))
    } catch (e) {
      errors.push(String(e))
    }
  }
  return { cases, errors }
}

describe('oracle corpus meta', () => {
  const { cases, errors } = readAllCases()

  // A committed case list, not a floor: a renamed, dropped or duplicated
  // directory is itself the change reviewers have to see, and a count alone
  // cannot tell one case missing from another added. Update this list (and the
  // generated docs/oracle.md) in the same commit as the case.
  const EXPECTED_CASES = [
    '01-box',
    '02-box-symmetric',
    '03-box-reverse',
    '04-cylinder',
    '05-hole-through',
    '06-hole-blind',
    '07-hole-two-sites',
    '08-fillet-all-edges',
    '09-fillet-vertical-naming',
    '10-chamfer-one-edge',
    '11-chamfer-vertical',
    '12-revolve-pappus-full',
    '13-revolve-pappus-half',
    '14-array-plate-add',
    '15-array-cutters-subtract',
    '16-circular-array-holes',
    '17-mirror-keep',
    '18-mirror-merge',
    '19-boolean-union',
    '20-boolean-cut',
    '21-boolean-intersect',
    '22-boolean-union-enclosed-sphere',
    '23-boolean-cut-cavity',
    '24-boolean-intersect-octant',
    '25-extrude-up-to',
    '26-sweep-circle-line',
    '27-extrude-add',
    '28-delete-body',
    '29-transform-translate',
    '30-transform-rotate',
    '31-transform-scale',
    '32-hole-target-naming',
    '33-chamfer-vertical-naming',
    '34-shell-box-open-top',
    '35-shell-box-closed',
    '36-shell-cylinder-open-top',
    '37-sweep-helix-square',
    '38-sweep-helix-left',
    '39-sweep-sections-frustum',
    '40-hole-thread',
    '41-move-face-cylinder-wall',
    '42-move-face-bore',
    '43-annulus',
    '44-hole-counterbore',
    '45-split-holed-block-above',
    '46-split-holed-block-both',
  ]

  it('holds exactly the committed case list', () => {
    expect(listOracleDirs()).toEqual(EXPECTED_CASES)
  })

  it('every case directory has recipe.yaml and a valid expected.json with a non-empty method', () => {
    for (const name of listOracleDirs()) {
      expect(existsSync(join(ORACLE_DIR, name, 'recipe.yaml')), `${name}/recipe.yaml missing`).toBe(true)
      expect(existsSync(join(ORACLE_DIR, name, 'expected.json')), `${name}/expected.json missing`).toBe(true)
    }
    expect(errors, errors.join('; ')).toEqual([])
  })

  it('every case appears in the generated report', () => {
    const report = readFileSync(ORACLE_DOC_PATH, 'utf8')
    for (const c of cases) {
      expect(report, `${c.name} missing from docs/oracle.md`).toContain(`### ${c.name}`)
    }
  })

  it('the report names no case that is not in the corpus', () => {
    const report = readFileSync(ORACLE_DOC_PATH, 'utf8')
    const sections = [...report.matchAll(/^### (.+)$/gm)].map((m) => m[1])
    expect(sections.sort()).toEqual(cases.map((c) => c.name).sort())
  })
})
