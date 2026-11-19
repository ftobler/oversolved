// The dirty key an import's bytes contribute. One digest per import_step, taken
// from the file map the solve was actually handed; a replaced payload must move
// it even though the document and the file id are unchanged.

import { describe, it, expect } from 'vitest'
import { featuresWithImportDigests, IMPORT_BYTES_SPEC_KEY } from '../importFileBytes'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const digestOf = (feature: Record<string, unknown>): unknown => feature[IMPORT_BYTES_SPEC_KEY]

describe('featuresWithImportDigests', () => {
  it('leaves a spec with no import untouched, down to array identity', () => {
    const features = [{ id: 'sk1', kind: 'sketch' }, { id: 'ex1', kind: 'extrude' }]
    expect(featuresWithImportDigests(features, new Map([['f1', bytes('a')]]))).toBe(features)
  })

  it('folds a digest in without mutating the caller\'s feature', () => {
    const feature = { id: 'imp1', kind: 'import_step', file_id: 'f1' }
    const out = featuresWithImportDigests([feature], new Map([['f1', bytes('a')]]))
    expect(digestOf(out[0])).toMatch(/^[0-9a-f]{64}$/)
    expect(IMPORT_BYTES_SPEC_KEY in feature).toBe(false)
    expect(feature).toEqual({ id: 'imp1', kind: 'import_step', file_id: 'f1' })
  })

  it('gives identical bytes the same digest and a replaced payload a different one', () => {
    const feature = { id: 'imp1', kind: 'import_step', file_id: 'f1' }
    const digestFor = (text: string): unknown =>
      digestOf(featuresWithImportDigests([feature], new Map([['f1', bytes(text)]]))[0])
    expect(digestFor('A')).toBe(digestFor('A'))
    expect(digestFor('B')).not.toBe(digestFor('A'))
  })

  it('digests by file id: one file shared by two imports hashes once', () => {
    const features = [
      { id: 'imp1', kind: 'import_step', file_id: 'f1' },
      { id: 'imp2', kind: 'import_step', file_id: 'f1' },
    ]
    const out = featuresWithImportDigests(features, new Map([['f1', bytes('same')]]))
    expect(digestOf(out[0])).toBe(digestOf(out[1]))
  })

  it('leaves an import whose bytes this solve does not carry untouched', () => {
    const feature = { id: 'imp1', kind: 'import_step', file_id: 'missing' }
    expect(featuresWithImportDigests([feature], new Map([['f1', bytes('a')]]))[0]).toBe(feature)
  })
})
