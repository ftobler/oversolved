// Drift guard for the fit_spline tangent recipe and the helix sweep path in
// docs/drive.md. The catalogue note is the source: the doc must quote it, so a
// reworded note cannot leave the doc teaching the old recipe. The UNVERIFIED
// build123d claim it replaced asserted another library's internals; the ban
// keeps that marker from coming back. When this fails, fix the doc, not this file.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { FIT_SPLINE_TANGENT_MAGNITUDE_NOTE, SWEEP_HELIX_PATH_NOTE } from '../mutationCatalog'

const DRIVE_DOC = readFileSync(join(__dirname, '../../../../docs/drive.md'), 'utf8')
const DOCUMENT_DOC = readFileSync(join(__dirname, '../../../../docs/document.md'), 'utf8')

/** The doc's prose with its hard wraps and list indents collapsed to single spaces. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ')
}

describe('docs/drive.md fit_spline tangents', () => {
  it('carries no unverified claim about another library', () => {
    expect(DRIVE_DOC).not.toContain('UNVERIFIED')
    expect(DRIVE_DOC).not.toContain('is believed to')
  })

  it('quotes the catalogue magnitude sentence verbatim', () => {
    expect(flat(DRIVE_DOC)).toContain(FIT_SPLINE_TANGENT_MAGNITUDE_NOTE)
  })

  it('spells the handle formulas with the chord span, not the unit-chord form', () => {
    const doc = flat(DRIVE_DOC)
    expect(doc).toContain('`P0 + h0 * t0 / 3`')
    expect(doc).toContain('`P_last - h_last * t1 / 3`')
    expect(doc).toContain('the end tangents after any `ScaleTangents` scaling')
  })
})

describe('helix as a sweep path', () => {
  it('is named in the drive sweep paragraph and the document helix section', () => {
    expect(flat(DRIVE_DOC)).toContain(SWEEP_HELIX_PATH_NOTE)
    expect(flat(DOCUMENT_DOC)).toContain('A bare `$<id>` or `@<id>` is a valid sweep `path`')
  })
})
