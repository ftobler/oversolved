// The one place the ambient-occlusion gate and the radius scale are defined.
// Everything else (the presenter, the body material, the store) asks these
// functions instead of keeping its own copy of the rules.
import { describe, expect, it, afterEach } from 'vitest'
import * as THREE from 'three'
import {
  AO_OCCLUDER_LAYER,
  aoFallbackTexture,
  aoUniforms,
  applyAoOccluder,
  aoRadiusFor,
  isAoActive,
  isAoCapturing,
  setAoCapturing,
  type AoActiveInput,
} from '@/components/Viewport/ambientOcclusion'

const ACTIVE: AoActiveInput = {
  option: true,
  shading: true,
  zebra: false,
  curvature: false,
  section: false,
  capturing: false,
}

describe('isAoActive', () => {
  afterEach(() => { setAoCapturing(false) })

  it('is on only when every layer it needs agrees', () => {
    expect(isAoActive(ACTIVE)).toBe(true)
  })

  it('follows the option row', () => {
    expect(isAoActive({ ...ACTIVE, option: false })).toBe(false)
    expect(isAoActive({ ...ACTIVE, shading: false })).toBe(false)
  })

  it('gives way to every mode that replaces the surface', () => {
    expect(isAoActive({ ...ACTIVE, zebra: true })).toBe(false)
    expect(isAoActive({ ...ACTIVE, curvature: true })).toBe(false)
    expect(isAoActive({ ...ACTIVE, section: true })).toBe(false)
    expect(isAoActive({ ...ACTIVE, capturing: true })).toBe(false)
  })

  it('needs every flag, so a bare option cannot switch it on alone', () => {
    const yes = new Set(['option', 'shading'])
    const flags = Object.keys(ACTIVE) as (keyof AoActiveInput)[]
    for (const off of flags.filter(f => !yes.has(f))) {
      expect(isAoActive({ ...ACTIVE, [off]: !ACTIVE[off] })).toBe(false)
    }
  })
})

describe('aoRadiusFor', () => {
  it('is proportional to the visible extent, so a unit change is a scale change', () => {
    expect(aoRadiusFor(2)).toBeCloseTo(2 * aoRadiusFor(1))
    expect(aoRadiusFor(25.4) / aoRadiusFor(1)).toBeCloseTo(25.4)
  })

  it('never returns a zero or non-finite radius', () => {
    // A degenerate or not-yet-measured model must still produce a usable
    // radius for the first frame.
    for (const extent of [0, Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      const radius = aoRadiusFor(extent)
      expect(Number.isFinite(radius)).toBe(true)
      expect(radius).toBeGreaterThan(0)
    }
  })
})

describe('occluder layer', () => {  it('marks an opaque face and clears a see-through one', () => {
    const layers = new THREE.Layers()
    applyAoOccluder(layers, true)
    expect(layers.isEnabled(AO_OCCLUDER_LAYER)).toBe(true)
    applyAoOccluder(layers, false)
    expect(layers.isEnabled(AO_OCCLUDER_LAYER)).toBe(false)
  })

  it('tolerates a stand-in mesh with no layers (a DOM render)', () => {
    expect(() => applyAoOccluder(undefined, true)).not.toThrow()
  })
})

describe('capturing flag', () => {
  afterEach(() => { setAoCapturing(false) })

  it('round-trips', () => {
    expect(isAoCapturing()).toBe(false)
    setAoCapturing(true)
    expect(isAoCapturing()).toBe(true)
    setAoCapturing(false)
    expect(isAoCapturing()).toBe(false)
  })
})

describe('fallback texture', () => {
  it('is a one-texel white image the uniforms can start on', () => {
    // The body material samples tAO whether or not the AO stage ran, so the
    // published value is never null: white means "no occlusion".
    expect(aoUniforms.tAO.value).toBe(aoFallbackTexture)
    expect(aoFallbackTexture.image.width).toBe(1)
    expect(aoFallbackTexture.image.height).toBe(1)
    expect(Array.from(aoFallbackTexture.image.data as Uint8Array)).toEqual([255, 255, 255, 255])
  })
})
