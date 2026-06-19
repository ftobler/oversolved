// Dual-run parity gate for postRegister.ts against Python `_post_register`.
//
// Feeds each (feature, feature_result) pair from the Python-generated fixture
// through the TS port and asserts the same slash registry (`@feature/entity/sub`
// elements), `_pt_` frame, and topology surface/edge/vertex ancestral payloads.
// This is the direct parity check for the half the full-doc harness barely
// exercises (solved-entity slash + topology ancestry, the pick/dimension layer).
//
// The fixture is a frozen golden snapshot; its generator
// (gen_postregister_fixture.py) was deleted with the Python kernel in phase 4d.

import { describe, it, expect } from 'vitest'
import { initGlobalRepo } from '../query'
import { postRegister } from './postRegister'
import fixture from './__fixtures__/postRegister.json'

type Dict = Record<string, unknown>

interface AncestralEntry {
  ids: string[]
  payloads: unknown[]
}
interface Expected {
  slash: Record<string, unknown>
  pt: unknown
  ancestral: AncestralEntry[]
}
interface Case {
  feature: Dict
  feature_result: Dict
  expected: Expected
}

const TOL = 1e-6

/** Deep equality with a float tolerance on numbers; object key order independent. */
function approxEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= TOL
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((x, i) => approxEqual(x, b[i]))
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as Dict)
    const kb = Object.keys(b as Dict)
    if (ka.length !== kb.length) return false
    return ka.every((k) => k in (b as Dict) && approxEqual((a as Dict)[k], (b as Dict)[k]))
  }
  return a === b
}

/** Snapshot TS ancestral as the same [{ids, payloads}] shape the fixture dumps. */
function tsAncestral(repo: ReturnType<typeof initGlobalRepo>): AncestralEntry[] {
  const out: AncestralEntry[] = []
  for (const entry of repo.ancestral.values()) {
    out.push({
      ids: [...entry.set].sort(),
      payloads: entry.eids.map((eid) => repo.elements.get(eid)),
    })
  }
  return out
}

const cases = fixture as unknown as Record<string, Case>

describe('postRegister parity vs Python _post_register', () => {
  for (const [name, c] of Object.entries(cases)) {
    describe(name, () => {
      const repo = initGlobalRepo()
      postRegister(repo, c.feature.id as string, c.feature, c.feature_result)
      const fid = c.feature.id as string

      it('registers the solved slash geometry (@feature/entity/sub)', () => {
        for (const [key, payload] of Object.entries(c.expected.slash)) {
          const got = repo.elements.get(key)
          expect(got, `slash element ${key} missing`).toBeDefined()
          expect(approxEqual(got, payload), `slash ${key}: ${JSON.stringify(got)} != ${JSON.stringify(payload)}`).toBe(true)
        }
        // No extra slash elements beyond the fixture (catches over-registration).
        const tsSlash = [...repo.elements.keys()].filter((k) => k.includes('/') && k.split('/')[0] === fid)
        expect(tsSlash.sort()).toEqual(Object.keys(c.expected.slash).sort())
      })

      it('registers the plane frame (_pt_)', () => {
        const got = repo.elements.get('_pt_' + fid)
        expect(approxEqual(got, c.expected.pt), `_pt_ ${JSON.stringify(got)} != ${JSON.stringify(c.expected.pt)}`).toBe(true)
      })

      it('registers topology surface/edge/vertex ancestry', () => {
        const got = tsAncestral(repo)
        expect(got.length, 'ancestral entry count').toBe(c.expected.ancestral.length)
        // Match as a multiset: each expected entry must have a TS entry with the
        // same ancestor id set and payloads within tolerance.
        const unused = [...got]
        for (const exp of c.expected.ancestral) {
          const idx = unused.findIndex(
            (g) => approxEqual(g.ids, exp.ids) && approxEqual(g.payloads, exp.payloads),
          )
          expect(idx, `no TS ancestral entry for ids=${JSON.stringify(exp.ids)} payloads=${JSON.stringify(exp.payloads)}`).toBeGreaterThanOrEqual(0)
          unused.splice(idx, 1)
        }
      })

      it('re-solve with identical geometry keeps the ancestral entry count stable', () => {
        // postRegister clears the feature's prior entries then re-registers, so
        // element ids churn (Python does too); the entry COUNT must stay fixed --
        // no accumulation under repeated solves (the registry invariant at
        // solver_registry.py:19-26).
        const countBefore = repo.ancestral.size
        postRegister(repo, fid, c.feature, c.feature_result)
        expect(repo.ancestral.size).toBe(countBefore)
      })
    })
  }
})
