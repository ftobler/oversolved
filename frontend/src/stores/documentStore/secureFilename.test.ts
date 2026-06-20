// Parity coverage for the werkzeug `secure_filename` port. The backup zip the
// static build exports must round-trip through the server's import endpoint, so
// these cases mirror werkzeug.utils.secure_filename's documented behaviour.
// If this ever diverges from the Python side, backup import/export silently
// writes mismatched entry paths.

import { describe, it, expect } from 'vitest'
import { secureFilename } from './secureFilename'

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
