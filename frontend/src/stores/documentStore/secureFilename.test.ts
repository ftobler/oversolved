// Parity coverage for the werkzeug `secure_filename` port. The backup zip the
// static build exports must round-trip through the server's import endpoint, so
// these cases mirror werkzeug.utils.secure_filename's documented behaviour.
// If this ever diverges from the Python side, backup import/export silently
// writes mismatched entry paths.

import { describe, it, expect } from 'vitest'
import { secureFilename, uniqueStem } from './secureFilename'

describe('secureFilename', () => {
  it('joins internal spaces with underscores', () => {
    expect(secureFilename('My cool movie.mov')).toBe('My_cool_movie.mov')
  })

  it('strips directory traversal sequences', () => {
    // werkzeug's canonical example: forward slashes become spaces, the leading
    // dot/underscore run is trimmed, leaving the basename joined by underscores.
    expect(secureFilename('../../../etc/passwd')).toBe('etc_passwd')
  })

  it('replaces forward slashes with underscores (werkzeug parity)', () => {
    expect(secureFilename('foo/bar/baz.yaml')).toBe('foo_bar_baz.yaml')
  })

  it('treats backslash as a separator (diverges from werkzeug on Linux)', () => {
    // NOTE: this is a known divergence from the server. werkzeug only treats
    // os.sep / os.altsep as separators, so on a Linux server os.altsep is None
    // and a backslash is stripped, not split: 'bar\\baz' -> 'barbaz', giving
    // 'foo_barbaz.yaml'. This port replaces '\\' too, yielding 'foo_bar_baz'.
    // Pinned here so the difference is visible if backup parity ever matters
    // for names containing backslashes.
    expect(secureFilename('foo/bar\\baz.yaml')).toBe('foo_bar_baz.yaml')
  })

  it('collapses runs of whitespace into a single underscore', () => {
    expect(secureFilename('a   b\t\nc.txt')).toBe('a_b_c.txt')
  })

  it('drops non-ASCII after NFKD normalization', () => {
    // é decomposes to "e" + combining acute (>= 128), which is filtered out.
    expect(secureFilename('résumé.pdf')).toBe('resume.pdf')
  })

  it('returns empty string when every character is non-ASCII', () => {
    expect(secureFilename('中文')).toBe('')
  })

  it('keeps the extension when the stem is all non-ASCII', () => {
    expect(secureFilename('中文.txt')).toBe('txt')
  })

  it('removes disallowed punctuation', () => {
    expect(secureFilename('in*va:lid?name.txt')).toBe('invalidname.txt')
  })

  it('trims leading dots so dotfiles are not produced', () => {
    expect(secureFilename('.htaccess')).toBe('htaccess')
  })

  it('trims trailing dots and underscores', () => {
    expect(secureFilename('weird_name._.')).toBe('weird_name')
  })

  it('preserves dots and dashes inside the name', () => {
    expect(secureFilename('my-file.v1.2.yaml')).toBe('my-file.v1.2.yaml')
  })

  it('matches werkzeug.secure_filename including the Windows device rule', () => {
    // Expected values generated directly from werkzeug.utils.secure_filename
    // (Werkzeug 3.1.8) via `unittest.mock.patch.object(os, 'name', 'nt')`:
    // werkzeug gates the reserved-device-name underscore on running under
    // Windows, and this port applies it unconditionally (see secureFilename.ts),
    // so device rows must be generated with the nt patch while plain names are
    // identical under either os.name.
    const cases: [string, string][] = [
      ['nul', '_nul'],
      ['nul.txt', '_nul.txt'],
      ['com1', '_com1'],
      ['Com4.backup', '_Com4.backup'],
      ['lpt9.yaml', '_lpt9.yaml'],
      ['aux', '_aux'],
      ['prn.tar.gz', '_prn.tar.gz'],
      ['con', '_con'],
      ['null', 'null'],
      ['nul2', 'nul2'],
      ['constant', 'constant'],
      ['console', 'console'],
      ['My Part', 'My_Part'],
      ['box.stp', 'box.stp'],
    ]
    for (const [input, expected] of cases) {
      expect(secureFilename(input)).toBe(expected)
    }
  })

  it('stays idempotent across the device-name prefix', () => {
    expect(secureFilename('_nul')).toBe('_nul')
    expect(secureFilename('_com1.yaml')).toBe('_com1.yaml')
  })

  it('returns empty string for whitespace-only input', () => {
    expect(secureFilename('   ')).toBe('')
  })

  it('returns empty string for dots-only input', () => {
    expect(secureFilename('...')).toBe('')
  })

  it('returns empty string for empty input', () => {
    expect(secureFilename('')).toBe('')
  })

  it('is idempotent', () => {
    for (const input of [
      'My cool movie.mov',
      '../../../etc/passwd',
      '中文.txt',
      '.htaccess',
      'in*va:lid?name.txt',
    ]) {
      const once = secureFilename(input)
      expect(secureFilename(once)).toBe(once)
    }
  })

  it('produces an output safe for the <user>/<name>.yaml entry shape', () => {
    // The two path segments are sanitized independently before being joined,
    // so neither may reintroduce a separator.
    const user = secureFilename('Ada Lovelace')
    const name = secureFilename('Difference Engine.yaml')
    const entry = `${user}/${name}`
    expect(entry).toBe('Ada_Lovelace/Difference_Engine.yaml')
    expect(entry.split('/')).toHaveLength(2)
  })
})

// One suffixing rule, shared by the folder library and the bundle format. They
// have to agree: a document exported from a folder and imported back has to
// come out with the name it went in with.
describe('uniqueStem', () => {
  const takenIn = (...names: string[]) => (c: string) => names.includes(c)

  it('leaves a free stem alone', () => {
    expect(uniqueStem('Bracket', takenIn())).toBe('Bracket')
  })

  it('suffixes a taken stem and keeps counting', () => {
    expect(uniqueStem('Bracket', takenIn('Bracket'))).toBe('Bracket_1')
    expect(uniqueStem('Bracket', takenIn('Bracket', 'Bracket_1'))).toBe('Bracket_2')
  })

  // A dotted name reads as having an extension whether or not it is one, so the
  // suffix goes before the last dot and leaves that tail intact.
  it('inserts the suffix before the last dot', () => {
    expect(uniqueStem('Bracket.v2', takenIn('Bracket.v2'))).toBe('Bracket_1.v2')
  })

  // A generated suffix must not land on a document that really is called that.
  it('skips a suffix another document already owns', () => {
    expect(uniqueStem('Untitled', takenIn('Untitled', 'Untitled_1'))).toBe('Untitled_2')
  })

  it('does not treat a leading dot as an extension boundary', () => {
    expect(uniqueStem('.hidden', takenIn('.hidden'))).toBe('.hidden_1')
  })
})
