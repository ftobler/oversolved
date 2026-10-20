import { describe, it, expect } from 'vitest'
import {
  insertReference,
  linkReferences,
  renameReference,
  selectionSetAnchor,
  unknownReferences,
} from '@/utils/core/reportReferences'

describe('report references', () => {
  it('finds name tokens in order', () => {
    expect(unknownReferences('see #a, then #b_2 and #c-d.', [])).toEqual(['a', 'b_2', 'c-d'])
  })

  it('does not read a doubled hash or a hash glued to a word as a token', () => {
    expect(unknownReferences('## heading\nfoo#bar', [])).toEqual([])
  })

  // The rename is the reason whole-token matching exists: a prefix rewrite
  // would silently turn #ab into #b#b.
  it('renames only the whole token', () => {
    expect(renameReference('see #a, #ab and #a.', 'a', 'b')).toBe('see #b, #ab and #b.')
  })

  it('leaves the text alone when the name does not change', () => {
    expect(renameReference('see #a', 'a', 'a')).toBe('see #a')
  })

  it('lists unknown tokens once each', () => {
    expect(unknownReferences('see #a, #b and #a again', ['b'])).toEqual(['a'])
  })

  it('links only names that exist as sets', () => {
    expect(linkReferences('see #a and #missing', ['a']))
      .toBe('see [#a](#selection-set-a) and #missing')
  })

  it('exposes the same anchor for the link and the section', () => {
    expect(selectionSetAnchor('before')).toBe('selection-set-before')
  })

  it('inserts a reference at the caret and returns the new caret', () => {
    expect(insertReference('see  here', 'before', 4, 4))
      .toEqual({ text: 'see #before here', caret: 11 })
  })

  it('replaces a selection rather than only inserting', () => {
    expect(insertReference('see here', 'x', 4, 8))
      .toEqual({ text: 'see #x', caret: 6 })
  })

  it('clamps a caret past the end of the text', () => {
    expect(insertReference('see', 'x', 99, 99)).toEqual({ text: 'see#x', caret: 5 })
  })
})
