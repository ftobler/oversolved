// Stage 8's static mate knowledge. The parameter table is the contract the mate
// editor renders from, so a kind gaining a field the solver ignores (or losing
// one it reads) has to fail here rather than in a silent document.

import { describe, it, expect } from 'vitest'
import type { MateKind } from '@/types/cad'
import {
  EMPTY_MATE_REF,
  MATE_KINDS,
  MATE_KIND_LABELS,
  isMateRefEmpty,
  mateParams,
  mateRefLabel,
  mateSummary,
  normalizeMateAngleDeg,
} from '@/utils/mateKinds'
import { ASSEMBLY_HANDLE } from '@/utils/assemblyBuiltins'

describe('MATE_KINDS', () => {
  it('covers every MateKind the solver maps to a Rust kind code', () => {
    // Mirrors MATE_KIND_TO_U8 in kernel/solveAssembly.ts. A kind offered in the
    // UI but absent there would silently author itself as `fixed` (its `?? 0`).
    const solverKinds: MateKind[] = [
      'fixed', 'spherical', 'parallel', 'sliding', 'rotating',
      'sliding_rotating', 'tangential', 'copy_rotation', 'parallel_plane_distance',
    ]
    expect([...MATE_KINDS].sort()).toEqual([...solverKinds].sort())
  })

  it('leads with fixed, the workhorse mate', () => {
    expect(MATE_KINDS[0]).toBe('fixed')
  })

  it('labels every kind', () => {
    for (const kind of MATE_KINDS) expect(MATE_KIND_LABELS[kind]).toBeTruthy()
  })
})

describe('mateParams', () => {
  // encodeMateInput (kernel/solveAssembly.ts) writes exactly these per mate. A
  // parameter offered outside this set would be authored into the document and
  // then dropped at the wire, which is worse than not offering it: the user sees
  // a number that does nothing.
  const WIRE_PARAMS = ['flip', 'offset', 'ratio', 'radius', 'angle']

  it('never offers a parameter the wire format cannot carry', () => {
    for (const kind of MATE_KINDS) {
      for (const param of mateParams(kind)) expect(WIRE_PARAMS).toContain(param)
    }
  })

  // Stronger than "the wire can carry it": restates, per kind, exactly which
  // params mate_residuals.rs's residual formulas actually read (the Rust doc
  // comment at the top of that file). A kind offering a param its own residual
  // ignores is a dead control -- e.g. `sliding` used to offer `offset`, which
  // the solver never read (Stage D: an offset along a prismatic joint's slide
  // axis would pin its only free DOF, a driven joint, not a mate).
  it('offers exactly the params the matching residual reads, per mate_residuals.rs', () => {
    const RUST_READS: Record<MateKind, readonly string[]> = {
      fixed: ['offset', 'flip', 'angle'],
      spherical: [],
      parallel: ['flip'],
      sliding: ['flip', 'angle'],
      rotating: ['flip'],
      sliding_rotating: ['flip'],
      tangential: ['offset', 'radius'],
      copy_rotation: ['ratio'],
      parallel_plane_distance: ['offset', 'flip'],
    }
    for (const kind of MATE_KINDS) {
      expect([...mateParams(kind)].sort()).toEqual([...RUST_READS[kind]].sort())
    }
  })

  it('sliding offers no offset (Stage D: an offset would pin the joint\'s only free DOF)', () => {
    expect(mateParams('sliding')).not.toContain('offset')
  })

  it('gives fixed its offset, flip and angle', () => {
    expect(mateParams('fixed')).toEqual(['offset', 'flip', 'angle'])
  })

  it('offers angle only where the solver reads a roll target (fixed and sliding)', () => {
    const withAngle = MATE_KINDS.filter(k => mateParams(k).includes('angle'))
    expect(withAngle).toEqual(['fixed', 'sliding'])
  })

  it('gives copy_rotation only its ratio', () => {
    expect(mateParams('copy_rotation')).toEqual(['ratio'])
  })

  it('gives tangential the mate-side radius fallback', () => {
    expect(mateParams('tangential')).toContain('radius')
  })

  // Every axis mate reads flip since the signed axis-difference rework: which
  // side a joint welds/hinges is authored (captured at the pick), no longer
  // derived from whichever side the seed happened to be nearer.
  it('offers flip only where the solver reads it', () => {
    const withFlip = MATE_KINDS.filter(k => mateParams(k).includes('flip'))
    expect(withFlip).toEqual(['fixed', 'sliding', 'rotating', 'sliding_rotating', 'parallel', 'parallel_plane_distance'])
  })

  it('gives spherical, the only orientation-free joint, no parameters at all', () => {
    expect(mateParams('spherical')).toEqual([])
  })
})

describe('isMateRefEmpty', () => {
  it('treats the freshly authored ref as empty', () => {
    expect(isMateRefEmpty(EMPTY_MATE_REF)).toBe(true)
  })

  it('treats a missing ref as empty', () => {
    expect(isMateRefEmpty(undefined)).toBe(true)
  })

  // A ref is picked as a pair. Half of one can only come from a corrupted
  // document, and treating it as filled would send the solver an unresolvable id.
  it('treats a half-filled ref as empty', () => {
    expect(isMateRefEmpty({ part: 'h1', anchor: '' })).toBe(true)
    expect(isMateRefEmpty({ part: '', anchor: 'a1' })).toBe(true)
  })

  it('treats a fully picked ref as filled', () => {
    expect(isMateRefEmpty({ part: 'h1', anchor: 'a1' })).toBe(false)
  })
})

describe('mateRefLabel', () => {
  it('prompts when nothing is picked', () => {
    expect(mateRefLabel(EMPTY_MATE_REF)).toBe('Pick a reference')
  })

  it('names the part through the label lookup', () => {
    expect(mateRefLabel({ part: 'h1', anchor: 'a1' }, () => 'Bracket')).toBe('Bracket / a1')
  })

  it('falls back to the raw handle when the part is unknown', () => {
    expect(mateRefLabel({ part: 'h9', anchor: 'a1' }, () => undefined)).toBe('h9 / a1')
  })

  // The reserved handle belongs to no PartInstance, so labelFor can never
  // resolve it; the assembly's own frame has to be named directly.
  it('names the assembly frame for the reserved handle', () => {
    expect(mateRefLabel({ part: ASSEMBLY_HANDLE, anchor: 'AssemblyTop' })).toBe('Assembly / AssemblyTop')
  })
})

describe('mateSummary', () => {
  it('reads as kind plus both references', () => {
    const s = mateSummary('fixed', { part: 'h1', anchor: 'a1' }, { part: 'h2', anchor: 'b2' })
    expect(s).toBe('Fixed: h1 / a1 to h2 / b2')
  })

  it('shows the unpicked half of a half-authored mate', () => {
    const s = mateSummary('spherical', { part: 'h1', anchor: 'a1' }, EMPTY_MATE_REF)
    expect(s).toBe('Spherical: h1 / a1 to Pick a reference')
  })
})

describe('normalizeMateAngleDeg', () => {
  it('walks a full turn of +90 presses back to zero', () => {
    // The behaviour the editor's +90 button is built on: pressing it forever
    // must keep landing on a legal angle, never on a rejected one.
    let a = 0
    const seen: number[] = []
    for (let i = 0; i < 4; i++) {
      a = normalizeMateAngleDeg(a + 90)
      seen.push(a)
    }
    expect(seen).toEqual([90, 180, 270, 0])
  })

  it('wraps a -90 press below zero up into the top of the range', () => {
    expect(normalizeMateAngleDeg(0 - 90)).toBe(270)
    expect(normalizeMateAngleDeg(270 - 90)).toBe(180)
  })

  it('collapses a whole turn onto zero from either side', () => {
    expect(normalizeMateAngleDeg(360)).toBe(0)
    expect(normalizeMateAngleDeg(-360)).toBe(0)
    // A negative zero would reach the YAML as `-0`; the range's floor is plain 0.
    expect(Object.is(normalizeMateAngleDeg(-360), 0)).toBe(true)
  })

  it('keeps values already inside [0, 360) untouched', () => {
    expect(normalizeMateAngleDeg(0)).toBe(0)
    expect(normalizeMateAngleDeg(30)).toBe(30)
    expect(normalizeMateAngleDeg(180)).toBe(180)
    expect(normalizeMateAngleDeg(359.999)).toBe(359.999)
  })

  it('folds a typed negative or many-turn value into the range', () => {
    expect(normalizeMateAngleDeg(-90)).toBe(270)
    expect(normalizeMateAngleDeg(-10)).toBe(350)
    expect(normalizeMateAngleDeg(400)).toBe(40)
    expect(normalizeMateAngleDeg(1080 + 45)).toBe(45)
    expect(normalizeMateAngleDeg(-1080 - 45)).toBe(315)
  })

  it('authors zero rather than NaN for a non-finite input', () => {
    expect(normalizeMateAngleDeg(NaN)).toBe(0)
    expect(normalizeMateAngleDeg(Infinity)).toBe(0)
  })
})
