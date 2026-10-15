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

  it('has at least 30 cases', () => {
    expect(cases.length, 'the oracle corpus lost cases').toBeGreaterThanOrEqual(30)
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
