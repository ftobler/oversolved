// One vocabulary for "this typeRestriction names a face". `isFaceRestriction`
// in occ/primitives.ts is the only place the face kinds are written as a
// predicate; every consumer calls it. Two hand predicates had already drifted
// from the shared six (fillet/chamfer's edge expansion and projection lowering
// stopped at `cylinderface`), so a countersink cone resolved nothing.
//
// The scan targets exactly that shape: a same-line union of three or more face
// subtypes, or one that also names the `face` catch-all. It is a same-line,
// single-quote, src/kernel scan: a drift guard, not a proof. Subset DATA stays
// legal: the analytic-surface set delete face can extend, the axis-carrying
// set select reads, the editor's pick refusal list and helix's two-kind
// refusal are not a restriction predicate, and a type-only import keeps OCC
// out of those leaves.

import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { productionFiles, liveText } from '@/testing/sourceScan'

const SRC = join(__dirname, '../../')

const FACE_SUBTYPE = /'(flatface|cylinderface|coneface|sphereface|torusface)'/g

/** The distinct face subtypes a line names, for a line that reads as a
 *  restriction predicate; null for any other line. A drifted restriction list
 *  is a union of three or more kinds, or any list that also names the `face`
 *  catch-all; a two-kind refusal or subset check is not one. */
function predicateKinds(line: string): string[] | null {
  const kinds = [...new Set(Array.from(line.matchAll(FACE_SUBTYPE), (m) => m[1]))]
  const namesCatchAll = /'face'/.test(line)
  const isUnion = line.includes('||')
  if (namesCatchAll && kinds.length >= 2) return kinds.sort()
  if (!namesCatchAll && isUnion && kinds.length >= 3) return kinds.sort()
  return null
}

describe('face restriction kinds have one home', () => {
  const sources = productionFiles(SRC)

  it('scans a non-empty source tree', () => {
    expect(sources.length).toBeGreaterThan(150)
  })

  it('keeps the last hand predicate out of every file but primitives.ts', () => {
    const offenders: string[] = []
    for (const file of sources) {
      if (file.endsWith(join('occ', 'primitives.ts'))) continue
      const lines = liveText(file).split('\n')
      lines.forEach((line, i) => {
        const kinds = predicateKinds(line)
        if (kinds !== null) {
          offenders.push(`${file.slice(SRC.length + 1)}:${i + 1} [${kinds.join(', ')}] ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
