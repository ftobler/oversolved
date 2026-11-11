import { describe, it, expect } from 'vitest'
import {
  insertReference,
  linkReferences,
  renameReference,
  selectionSetAnchor,
  selectionSetAnchors,
  unknownReferences,
} from '@/utils/core/reportReferences'

describe('report references', () => {
  it('finds name tokens in order', () => {
    expect(unknownReferences('see #a, then #b_2 and #c-d.', [])).toEqual(['a', 'b_2', 'c-d'])
  })

  it('reads Unicode letters, marks and digits as name characters', () => {
    expect(unknownReferences('see #Gehäuse, #面 and #名前_2', []))
      .toEqual(['Gehäuse', '面', '名前_2'])
  })

  // A decomposed umlaut is two code points; the combining mark still belongs
  // to the token rather than ending it.
  it('keeps a combining mark inside the token', () => {
    expect(unknownReferences('see #Geha\u0308use', [])).toEqual(['Geha\u0308use'])
  })

  it('does not read a doubled hash or a hash glued to a word as a token', () => {
    expect(unknownReferences('## heading\nfoo#bar', [])).toEqual([])
  })

  // The rename is the reason whole-token matching exists: a prefix rewrite
  // would silently turn #ab into #b#b.
  it('renames only the whole token', () => {
    expect(renameReference('see #a, #ab and #a.', 'a', 'b')).toBe('see #b, #ab and #b.')
  })

  it('renames only the whole Unicode token', () => {
    expect(renameReference('see #ä, #äh and #ä.', 'ä', 'ö')).toBe('see #ö, #äh and #ö.')
    expect(renameReference('see #Gehäuse and #Gehäuse2', 'Gehäuse', 'Box'))
      .toBe('see #Box and #Gehäuse2')
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

  it('links a Unicode token to its slugged anchor', () => {
    expect(linkReferences('see #Gehäuse', ['Gehäuse']))
      .toBe('see [#Gehäuse](#selection-set-gehäuse)')
  })

  it('does not link a token that is only a prefix of a longer token', () => {
    expect(linkReferences('see #a and #ab', ['a'])).toBe('see [#a](#selection-set-a) and #ab')
  })

  it('exposes the same anchor for the link and the section', () => {
    expect(selectionSetAnchor('before')).toBe('selection-set-before')
  })

  it('slugifies a name into a stable HTML id', () => {
    expect(selectionSetAnchor('Gehäuse')).toBe('selection-set-gehäuse')
    expect(selectionSetAnchor('A_B C!')).toBe('selection-set-a-b-c')
    expect(selectionSetAnchor('---')).toBe('selection-set-set')
  })

  // Names are unique, but their slugs are not: case and `_` versus `-` can
  // collapse two names onto one id, and the heading ids must stay distinct.
  it('suffixes a slug collision so each set keeps its own anchor', () => {
    expect(selectionSetAnchors(['Foo', 'foo', 'Foo'])).toEqual([
      'selection-set-foo',
      'selection-set-foo-2',
      'selection-set-foo-3',
    ])
  })

  it('links colliding names to their own anchors', () => {
    expect(linkReferences('see #Foo and #foo', ['Foo', 'foo']))
      .toBe('see [#Foo](#selection-set-foo) and [#foo](#selection-set-foo-2)')
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
