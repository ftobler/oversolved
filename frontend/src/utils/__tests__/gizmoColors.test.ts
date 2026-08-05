/**
 * The assembly triad is meant to be re-hueable by editing one line in
 * utils/core/gizmoColors. These tests lock that in from both ends: the derived
 * shades must actually follow TRIAD_COLOR, and the two components that draw the
 * triad must not smuggle a colour of their own back in.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  darkenHex, TRIAD_COLOR, TRIAD_COLOR_DIM, TRIAD_COLOR_HOVER,
} from '@/utils/core/gizmoColors'
import { COLOR_HOVER, COLOR_PREVIEW_EDGE } from '@/utils/core/partColors'

const SRC = join(__dirname, '../../')
const TRIAD_GIZMO = join(SRC, 'components/Viewport/assembly/TriadGizmo.tsx')
const ANGLE_DIAL = join(SRC, 'components/Viewport/assembly/AngleDial.tsx')

/** Every hex literal in a file, ignoring the ones inside comments. */
function hexLiterals(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  return code.match(/#[0-9a-fA-F]{6}\b/g) ?? []
}

describe('gizmoColors', () => {
  // Deliberately not `toBe('#ecad2b')`: pinning the literal here would make
  // re-hueing the triad a two-file edit, which is the exact thing this module
  // exists to prevent. What must hold is that the value is usable by the
  // derivation helpers and that the triad no longer borrows partColors' hues.
  it('is a full six-digit hex the shade helpers can parse', () => {
    expect(TRIAD_COLOR).toMatch(/^#[0-9a-fA-F]{6}$/)
  })

  it('is not the white or the preview-edge pink the triad used to borrow', () => {
    expect(TRIAD_COLOR.toLowerCase()).not.toBe(COLOR_HOVER.toLowerCase())
    expect(TRIAD_COLOR.toLowerCase()).not.toBe(COLOR_PREVIEW_EDGE.toLowerCase())
  })

  it('derives the hover shade from the base hue, and not from white', () => {
    expect(TRIAD_COLOR_HOVER).not.toBe(TRIAD_COLOR)
    expect(TRIAD_COLOR_HOVER.toLowerCase()).not.toBe('#ffffff')
    // Lighter than the base on every channel, so it still reads as the same hue.
    for (let at = 1; at < 7; at += 2) {
      const base = parseInt(TRIAD_COLOR.slice(at, at + 2), 16)
      const hover = parseInt(TRIAD_COLOR_HOVER.slice(at, at + 2), 16)
      expect(hover).toBeGreaterThanOrEqual(base)
    }
  })

  it('derives the dim shade darker than the base hue', () => {
    for (let at = 1; at < 7; at += 2) {
      const base = parseInt(TRIAD_COLOR.slice(at, at + 2), 16)
      const dim = parseInt(TRIAD_COLOR_DIM.slice(at, at + 2), 16)
      expect(dim).toBeLessThan(base)
    }
  })

  // Neutral literals, not TRIAD_COLOR: these pin darkenHex's arithmetic, which
  // must stay true whatever hue the triad is wearing.
  it('darkenHex returns the colour unchanged at 0 and black at 1', () => {
    expect(darkenHex('#3c8ad0', 0)).toBe('#3c8ad0')
    expect(darkenHex('#3c8ad0', 1)).toBe('#000000')
  })

  it('darkenHex scales channels independently and pads single digits', () => {
    expect(darkenHex('#804020', 0.5)).toBe('#402010')
  })
})

describe('triad components source their colours centrally', () => {
  it('TriadGizmo imports from gizmoColors and holds no hex literals', () => {
    const source = readFileSync(TRIAD_GIZMO, 'utf8')
    expect(source).toContain("from '@/utils/core/gizmoColors'")
    expect(hexLiterals(source)).toEqual([])
  })

  it('AngleDial imports from gizmoColors and holds no hex literals', () => {
    const source = readFileSync(ANGLE_DIAL, 'utf8')
    expect(source).toContain("from '@/utils/core/gizmoColors'")
    expect(hexLiterals(source)).toEqual([])
  })

  it('neither triad component pulls colours out of partColors', () => {
    // Word-anchored so the triad's own TRIAD_COLOR_HOVER does not trip this.
    for (const file of [TRIAD_GIZMO, ANGLE_DIAL]) {
      const source = readFileSync(file, 'utf8')
      expect(source).not.toMatch(/(?<![A-Z_])COLOR_HOVER/)
      expect(source).not.toMatch(/(?<![A-Z_])COLOR_PREVIEW_EDGE/)
      expect(source).not.toContain("from '@/utils/core/partColors'")
    }
  })
})
