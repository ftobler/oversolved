import { describe, it, expect } from 'vitest'
import {
  defaultExportFileName,
  ensureExtension,
  sanitizeBaseName,
  swapExtension,
} from '@/utils/core/exportFileName'

describe('sanitizeBaseName', () => {
  it('replaces spaces with underscores by default', () => {
    expect(sanitizeBaseName('motor mount')).toBe('motor_mount')
  })

  it('follows an existing dash convention', () => {
    expect(sanitizeBaseName('motor-mount v2')).toBe('motor-mount-v2')
  })

  it('prefers underscores when the name mixes both separators', () => {
    expect(sanitizeBaseName('motor-mount_plate rev b')).toBe('motor-mount_plate_rev_b')
  })

  it('collapses runs of whitespace into a single separator', () => {
    expect(sanitizeBaseName('  motor   mount  ')).toBe('motor_mount')
  })

  it('falls back to a placeholder for a blank name', () => {
    expect(sanitizeBaseName('   ')).toBe('export')
  })
})

describe('swapExtension', () => {
  it('replaces the trailing extension', () => {
    expect(swapExtension('part.step', 'stl')).toBe('part.stl')
  })

  it('appends when there is no extension', () => {
    expect(swapExtension('part', 'yaml')).toBe('part.yaml')
  })

  it('leaves a leading dot alone', () => {
    expect(swapExtension('.hidden', 'step')).toBe('.hidden.step')
  })
})

describe('ensureExtension', () => {
  it('appends a missing extension', () => {
    expect(ensureExtension('part', 'step')).toBe('part.step')
  })

  it('keeps a name that already has the extension', () => {
    expect(ensureExtension('part.step', 'step')).toBe('part.step')
  })

  it('ignores extension case', () => {
    expect(ensureExtension('part.STEP', 'step')).toBe('part.STEP')
  })

  it('does not treat an unrelated dot as an extension', () => {
    expect(ensureExtension('bracket v1.2', 'stl')).toBe('bracket v1.2.stl')
  })

  it('trims and falls back for an emptied field', () => {
    expect(ensureExtension('  ', 'yaml')).toBe('export.yaml')
    expect(ensureExtension(' part ', 'stl')).toBe('part.stl')
  })
})

describe('defaultExportFileName', () => {
  it('combines the sanitized document name with the format extension', () => {
    expect(defaultExportFileName('motor mount', 'step')).toBe('motor_mount.step')
  })
})
