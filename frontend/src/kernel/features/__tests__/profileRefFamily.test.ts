/**
 * The one family split a profile ref goes through, shared by the pick gate and
 * the build. A click on a sketch area and a click on a part face must be named
 * the same way at both ends, or the chip accepts what the build throws out.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { makeAncestryQuery, ref } from '../../query'
import {
  isEdgeProfileRef,
  isNonPlanarProfileFace,
  mixedProfileRefs,
  profileRefFamily,
} from '../profileRefFamily'

interface CorpusDoc {
  label: string
  spec: { features: { kind: string; sketch?: string | string[] }[] }
}

const sketchArea = makeAncestryQuery(['@sk1/l1', '@sk1/l2', 'surface:0', '@sk1'], 'flatface')
const partFace = '?15,4,9,15,15,15,15,7;@u|u_abc@ex1@body_ex1@sk1/c1@cls_yp:flatface'

describe('profileRefFamily', () => {
  it('puts whole sketches, sketch areas and entity picks in the sketch family', () => {
    for (const refStr of ['$sk1', '@sk1', sketchArea, 'entity:sk1:l1', 'vertex:sk1:l1:start']) {
      expect(profileRefFamily(refStr), refStr).toBe('sketch')
    }
  })

  it('puts face and edge queries in the part family', () => {
    for (const refStr of [
      '?9;@body_ex1:flatface', partFace, '@body_ex1/face/0', '@ex1/face/0',
      '?body_ex1:edge:0', makeAncestryQuery([ref('body_ex1'), ref('ex1')], 'straightedge'),
    ]) {
      expect(profileRefFamily(refStr), refStr).toBe('part')
    }
  })

  it('classifies a wrapped viewport pick by the query it will store', () => {
    // The chip stores the stripped query, so the gate must see the same face
    // the build will read, not the owner-attribution wrapper around it.
    expect(profileRefFamily(`face:ex1:${partFace}`)).toBe('part')
    expect(profileRefFamily(`edge:ex1:?body_ex1:edge:0`)).toBe('part')
  })

  it('keeps a datum-plane or unrecognised pick on the sketch side', () => {
    // Neither names a part face, so the chip must not call it a mixed pick.
    expect(profileRefFamily('?9;@builtin_plane_front:flatface')).toBe('sketch')
    expect(profileRefFamily('@sk1/c1')).toBe('sketch')
    // A non-fallback `@feature/...` ref takes the build's sketch-topo route
    // (resolveFaceProfile), not the body-face slash route.
    expect(profileRefFamily('@ex1/top_face')).toBe('sketch')
  })

  it('agrees with the build edge split and the regression corpus', () => {
    // The build routes edge refs into its face path with isEdgeProfileRef. Every
    // stored profile ref in the corpus is a whole-sketch ref, so the classifier
    // and that split must both leave it on the loop path.
    const path = fileURLToPath(new URL('../../../wasm-kernel/regression-baseline.json', import.meta.url))
    const corpus: CorpusDoc[] = JSON.parse(readFileSync(path, 'utf8'))
    const refs: string[] = []
    for (const doc of corpus) {
      for (const feature of doc.spec.features) {
        if (!['extrude', 'revolve', 'sweep', 'wrap'].includes(feature.kind)) continue
        const value = feature.sketch
        if (typeof value === 'string' && value !== '') refs.push(value)
        if (Array.isArray(value)) refs.push(...value.filter((r): r is string => typeof r === 'string'))
      }
    }
    expect(refs.length).toBeGreaterThan(0)
    for (const refStr of refs) {
      expect(profileRefFamily(refStr), refStr).toBe('sketch')
      expect(isEdgeProfileRef(refStr), refStr).toBe(false)
    }
    // The mirror of the corpus: an edge ref the build sends to its face path is
    // a part pick here, not a sketch area.
    const edge = '?body_ex1:edge:0'
    expect(isEdgeProfileRef(edge)).toBe(true)
    expect(profileRefFamily(edge)).toBe('part')
  })
})

describe('isNonPlanarProfileFace', () => {
  it('refuses a curved face query and accepts a flat one', () => {
    for (const kind of ['cylinderface', 'coneface', 'sphereface', 'torusface']) {
      expect(isNonPlanarProfileFace(`?9;@body_ex1:${kind}`)).toBe(true)
    }
    expect(isNonPlanarProfileFace('?9;@body_ex1:flatface')).toBe(false)
    // A generic `:face` says no kind, so the build stays its judge.
    expect(isNonPlanarProfileFace('?9;@body_ex1:face')).toBe(false)
    expect(isNonPlanarProfileFace(partFace)).toBe(false)
  })

  it('leaves sketch picks and topo-fallback faces to the build', () => {
    // A topo fallback carries no surface kind, so its planarity is a solve fact;
    // the build checks that one, not the chip.
    expect(isNonPlanarProfileFace(sketchArea)).toBe(false)
    expect(isNonPlanarProfileFace('entity:sk1:l1')).toBe(false)
    expect(isNonPlanarProfileFace('@body_ex1/face/0')).toBe(false)
  })
})

describe('mixedProfileRefs', () => {
  it('fires only when both families are present', () => {
    expect(mixedProfileRefs(['$sk1', sketchArea, 'entity:sk1:l1'])).toBe(false)
    expect(mixedProfileRefs(['?9;@body_ex1:flatface', '?body_ex1:edge:0'])).toBe(false)
    expect(mixedProfileRefs(['$sk1', '?9;@body_ex1:flatface'])).toBe(true)
    expect(mixedProfileRefs([])).toBe(false)
  })
})
