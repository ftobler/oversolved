// Stage 8's static mate knowledge. The parameter table is the contract the mate
// editor renders from, so a kind gaining a field the solver ignores (or losing
// one it reads) has to fail here rather than in a silent document.

import { describe, it, expect } from 'vitest'
import type { MateKind } from '@/types/cad'
import {
  EMPTY_MATE_REF,
  MATE_KINDS,
  MATE_KIND_LABELS,
  MATE_KIND_TO_U8,
  isMateRefEmpty,
  mateKindCode,
  mateParams,
  mateOffsetVector,
  mateReadsAxis,
  mateRefLabel,
  mateSummary,
  normalizeMateAngleDeg,
  unresolvedMateParams,
} from '@/utils/mateKinds'
import { ASSEMBLY_HANDLE } from '@/utils/assemblyBuiltins'
import type { Vec3 } from '@/utils/transform3d'

describe('MATE_KINDS', () => {
  it('maps every kind to a frozen code', () => {
    // The wire codes are MATE_KIND_TO_U8, typed `Record<MateKind, number>`, so
    // deleting a key fails tsc. This test is the fast detector for the two
    // mistakes tsc cannot see: a reorder and a changed number. Its diff is the
    // review signal against Rust's MateKind::from_u8 (mate.rs).
    const codes: Record<string, number | undefined> = {}
    for (const kind of MATE_KINDS) codes[kind] = mateKindCode(kind)
    expect(codes).toEqual({
      fixed: 0,
      spherical: 1,
      parallel: 2,
      sliding: 3,
      rotating: 4,
      sliding_rotating: 5,
      tangential: 6,
      copy_rotation: 7,
      parallel_plane_distance: 8,
    })
  })

  it('covers every MateKind the solver maps to a Rust kind code', () => {
    // MATE_KIND_TO_U8 is a Record<MateKind, number>, so tsc already fails if a
    // kind is missing; this restates the coverage at runtime so a future switch
    // to a looser type cannot quietly drop the check.
    for (const kind of MATE_KINDS) {
      expect(MATE_KIND_TO_U8[kind]).toBeTypeOf('number')
    }
  })

  it('returns undefined for a kind not in the union', () => {
    // Keeps solveAssembly's fail-loud branch live for a hand-edited YAML string
    // that is not a mate kind at all.
    expect(mateKindCode('not_a_kind')).toBeUndefined()
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

describe('mateReadsAxis', () => {
  // The single source of truth for which kinds consume `mate.a.axis` /
  // `mate.b.axis` (or, for copy_rotation, the seed axes). The solve refuses an
  // axis reader on a placeholder-axis anchor, so a kind miscategorised here
  // either welds about an invented +Z or blocks a legal point-only mate.
  it('is true exactly for the kinds whose residual reads an axis', () => {
    const readsAxis = MATE_KINDS.filter(k => mateReadsAxis(k))
    expect(readsAxis).toEqual([
      'fixed',
      'sliding',
      'rotating',
      'sliding_rotating',
      'parallel',
      'parallel_plane_distance',
      'copy_rotation',
    ])
  })

  // spherical is point-only, and tangential's axis arms fire only for anchor
  // kinds that carry an axis; a point/sphere pair falls to its point-only
  // fallback. Keeping both false is what keeps them legal on vertex anchors.
  it('leaves spherical and tangential axis-free', () => {
    expect(mateReadsAxis('spherical')).toBe(false)
    expect(mateReadsAxis('tangential')).toBe(false)
  })
})

describe('unresolvedMateParams', () => {
  it('names an expression-valued angle', () => {
    expect(unresolvedMateParams({ kind: 'fixed', angle: 'w / 2' })).toEqual(['angle'])
  })

  it('names a vector offset with any expression component', () => {
    expect(unresolvedMateParams({ kind: 'fixed', offset: { x: 'w / 2', y: 1 } })).toEqual(['offset'])
  })

  it('leaves an absent component legal', () => {
    expect(unresolvedMateParams({ kind: 'fixed', offset: { y: 2 } })).toEqual([])
    expect(unresolvedMateParams({ kind: 'fixed', offset: { x: 1 } })).toEqual([])
  })

  it('leaves plain numbers legal', () => {
    expect(unresolvedMateParams({ kind: 'tangential', offset: 5, radius: 2 })).toEqual([])
  })

  it('names a non-finite value', () => {
    expect(unresolvedMateParams({ kind: 'copy_rotation', ratio: NaN })).toEqual(['ratio'])
    expect(unresolvedMateParams({ kind: 'fixed', offset: Infinity })).toEqual(['offset'])
  })

  // The unknown-kind guard in solveAssembly owns the not-a-kind case; this
  // predicate must not double-report it as an unresolved parameter.
  it('returns nothing for an unknown kind', () => {
    expect(unresolvedMateParams({ kind: 'worm_gear', angle: 'x' })).toEqual([])
  })

  // A kind that does not read a param ignores a stray one rather than
  // reporting it: mateParams is the authority on which params are read.
  it('ignores a param the kind does not read', () => {
    expect(unresolvedMateParams({ kind: 'spherical', angle: 'w / 2' })).toEqual([])
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

describe('mateOffsetVector', () => {
  // The tolerant dual-read. Assembly documents are user YAML kept verbatim with
  // no content migration anywhere in the stack, so the legacy scalar form has to
  // keep working forever -- there is no version gate that could ever retire it.
  const Z: Vec3 = [0, 0, 1]

  it('expands a legacy scalar along body A\'s anchor axis', () => {
    expect(mateOffsetVector(7, Z)).toEqual([0, 0, 7])
    // Non-cardinal axis: the scalar is a distance ALONG the axis, not a z shift.
    expect(mateOffsetVector(10, [0, 0.6, 0.8])).toEqual([0, 6, 8])
  })

  it('reads a vector offset componentwise, independent of the axis', () => {
    expect(mateOffsetVector({ x: 3, y: 4, z: 5 }, Z)).toEqual([3, 4, 5])
    expect(mateOffsetVector({ x: 3, y: 4, z: 5 }, [1, 0, 0])).toEqual([3, 4, 5])
  })

  it('fills an unnamed component with zero rather than dropping the offset', () => {
    expect(mateOffsetVector({ y: 2 }, Z)).toEqual([0, 2, 0])
    expect(mateOffsetVector({}, Z)).toEqual([0, 0, 0])
  })

  it('reads an absent, expression or non-finite offset as no offset', () => {
    // Expression binding is not wired for mates yet; 0 is the solver's own
    // default for an absent offset, so an unbound formula moves nothing.
    expect(mateOffsetVector(undefined, Z)).toEqual([0, 0, 0])
    expect(mateOffsetVector('w / 2', Z)).toEqual([0, 0, 0])
    expect(mateOffsetVector({ x: 'w / 2', y: 1 }, Z)).toEqual([0, 1, 0])
    expect(mateOffsetVector(NaN, Z)).toEqual([0, 0, 0])
  })

  // Why the write side must NOT collapse `{x:0, y:0, z:5}` back to a bare `5`,
  // even though the two read identically for the anchor picked at the time.
  //
  // The two forms are not interchangeable: the vector is absolute in body A's
  // local frame, while the bare number means "this far along whatever axis
  // ref_a currently names". Re-pointing ref_a at a different anchor afterwards
  // therefore MOVES the part if the offset was collapsed, and leaves it exactly
  // where it was if it was not. Shortening the YAML would trade a stable form
  // for a context-dependent one -- the same hazard the read side already
  // refuses (MateEditor keeps a legacy scalar in its single box rather than
  // decompose it, because decomposing needs an axis it would have to invent).
  it('a bare-number offset is anchor-axis-relative, a vector is not', () => {
    const alongZ: Vec3 = [0, 0, 1]
    const alongX: Vec3 = [1, 0, 0]

    // The vector form holds still: same local displacement under either anchor.
    expect(mateOffsetVector({ x: 0, y: 0, z: 5 }, alongZ)).toEqual([0, 0, 5])
    expect(mateOffsetVector({ x: 0, y: 0, z: 5 }, alongX)).toEqual([0, 0, 5])

    // The "equivalent" scalar only agrees for the anchor it was collapsed
    // against; against another it names a completely different displacement.
    expect(mateOffsetVector(5, alongZ)).toEqual([0, 0, 5])
    expect(mateOffsetVector(5, alongX)).toEqual([5, 0, 0])
    expect(mateOffsetVector(5, alongX)).not.toEqual(mateOffsetVector({ x: 0, y: 0, z: 5 }, alongX))
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
