import { describe, it, expect } from 'vitest'
import {
  findReferences,
  insertReference,
  linkReferences,
  referenceToken,
  renameReference,
  selectionSetAnchor,
  selectionSetAnchors,
  unknownReferences,
} from '@/utils/core/reportReferences'

describe('report references', () => {
  it('finds name tokens in order', () => {
    expect(findReferences('see #a, then #b_2 and #c-d.')).toEqual(['a', 'b_2', 'c-d'])
  })

  // The short token is what a report already contains and what a plain name
  // still reads as; the bracketed one is the escape hatch for any other name.
  it('writes the short form for a plain name and the bracketed form otherwise', () => {
    expect(referenceToken('set1')).toBe('#set1')
    expect(referenceToken('set 1')).toBe('#[set 1]')
    expect(referenceToken('a]b')).toBe('#[a\\]b]')
    expect(referenceToken('a\\b')).toBe('#[a\\\\b]')
  })

  it('reads both the short and the bracketed token', () => {
    expect(findReferences('see #set1, #[set 1] and #[a\\]b]'))
      .toEqual(['set1', 'set 1', 'a]b'])
  })

  // The writer and the parser are one contract: every name a set can hold must
  // come back from the token written for it.
  it('round-trips every token form through the parser', () => {
    for (const name of ['set1', 'set 1', 'a]b', 'a\\b', '[x]', '#x', '  1  ']) {
      expect(findReferences(`see ${referenceToken(name)}`)).toEqual([name])
    }
  })

  // An unclosed bracket or an empty one names nothing, so neither starts a
  // token; a doubled hash and a hash glued to a word stay non-references.
  it('does not read a heading, an empty bracket or a glued hash as a token', () => {
    expect(findReferences('## heading\nword#[x] and #[] and #[open')).toEqual([])
  })

  it('reads Unicode letters, marks and digits as name characters', () => {
    expect(findReferences('see #Gehäuse, #面 and #名前_2'))
      .toEqual(['Gehäuse', '面', '名前_2'])
  })

  // A decomposed umlaut is two code points; the combining mark still belongs
  // to the token rather than ending it.
  it('keeps a combining mark inside the token', () => {
    expect(findReferences('see #Geha\u0308use')).toEqual(['Geha\u0308use'])
  })

  it('does not read a doubled hash or a hash glued to a word as a token', () => {
    expect(findReferences('## heading\nfoo#bar')).toEqual([])
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

  it('renames between the short and the bracketed form', () => {
    expect(renameReference('see #set1 and #[set1].', 'set1', 'set 1'))
      .toBe('see #[set 1] and #[set 1].')
    expect(renameReference('see #[set 1] and #set10', 'set 1', 'set1'))
      .toBe('see #set1 and #set10')
    expect(renameReference('see #[set1] and #set10', 'set1', 'other'))
      .toBe('see #other and #set10')
  })

  it('renames a name that carries the bracket escapes', () => {
    expect(renameReference('see #[a\\]b] and #[a]', 'a]b', 'c]d')).toBe('see #[c\\]d] and #[a]')
  })

  it('leaves the text alone when the name does not change', () => {
    expect(renameReference('see #a', 'a', 'a')).toBe('see #a')
    expect(renameReference('see #[a b]', 'a b', 'a b')).toBe('see #[a b]')
  })

  it('lists unknown tokens once each, carrying the token as written', () => {
    expect(unknownReferences('see #a, #[a] and #b and #a again', ['b']))
      .toEqual([{ token: '#a', name: 'a' }])
    expect(unknownReferences('see #[set 1] and #[a\\]b]', []))
      .toEqual([
        { token: '#[set 1]', name: 'set 1' },
        { token: '#[a\\]b]', name: 'a]b' },
      ])
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

  // CommonMark reads the link text, so the brackets inside a bracketed token
  // are escaped: `[#[set 1]]` would otherwise not be link text at all. HTML is
  // escaped too, so a free-text name cannot inject markup into the report.
  it('links a bracketed token with its brackets escaped', () => {
    expect(linkReferences('see #[set 1]', ['set 1']))
      .toBe('see [#\\[set 1\\]](#selection-set-set-1)')
    expect(linkReferences('see #[a\\]b]', ['a]b']))
      .toBe('see [#\\[a\\]b\\]](#selection-set-a-b)')
    expect(linkReferences('see #[a <b> & c]', ['a <b> & c']))
      .toBe('see [#\\[a &lt;b&gt; &amp; c\\]](#selection-set-a-b-c)')
  })

  it('leaves an unknown bracketed token plain', () => {
    expect(linkReferences('see #[set 1]', ['other'])).toBe('see #[set 1]')
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

  it('inserts the bracketed form for a free-text name', () => {
    expect(insertReference('see  here', 'set 1', 4, 4))
      .toEqual({ text: 'see #[set 1] here', caret: 12 })
  })

  // The parser rejects a `#` glued to a word, so an insertion beside one gets a
  // separating space; the caret lands past the trailing space.
  it('separates the token from an adjacent word', () => {
    expect(insertReference('seehere', 'x', 3, 3))
      .toEqual({ text: 'see #x here', caret: 7 })
    expect(insertReference('see here', 'x', 8, 8))
      .toEqual({ text: 'see here #x', caret: 11 })
    expect(insertReference('see here.', 'x', 8, 8))
      .toEqual({ text: 'see here #x.', caret: 11 })
  })

  it('replaces a selection rather than only inserting', () => {
    expect(insertReference('see here', 'x', 4, 8))
      .toEqual({ text: 'see #x', caret: 6 })
  })

  it('clamps a caret past the end of the text', () => {
    expect(insertReference('see', 'x', 99, 99)).toEqual({ text: 'see #x', caret: 6 })
  })
})
