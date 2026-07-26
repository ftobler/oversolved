import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import * as THREE from 'three'
import { useHighlightColors, paletteRGB } from '@/components/Geometry3D/useHighlightColors'
import { faceRuns, type HighlightPalette } from '@/components/Geometry3D/highlightColorPainter'
import { COLOR_SELECTED, COLOR_HOVER } from '@/components/Geometry3D/constants'

/**
 * The wiring half of the incremental highlight: the geometry's colour attribute
 * must be the SAME object across hover changes. Replacing it (what Body3D used to
 * do, once per pointer move) drops the GL buffer and re-uploads the body's whole
 * colour array -- the cost that made hovering an imported solid unusable.
 */

const FACES = 6
const TRIS_PER_FACE = 20
const TRI_COUNT = FACES * TRIS_PER_FACE

const RUNS = faceRuns(FACES, (f) => Array.from(
  { length: TRIS_PER_FACE }, (_, i) => f * TRIS_PER_FACE + i))

const PALETTE: HighlightPalette = {
  base: paletteRGB('#808080'),
  selected: paletteRGB(COLOR_SELECTED),
  hovered: paletteRGB(COLOR_HOVER),
}

function makeGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRI_COUNT * 9), 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRI_COUNT * 9), 3))
  return geometry
}

function hoverFlags(face: number | null): boolean[] {
  const flags = new Array<boolean>(FACES).fill(false)
  if (face !== null) flags[face] = true
  return flags
}

describe('useHighlightColors', () => {
  it('keeps one colour attribute across hover changes and uploads only its ranges', () => {
    const geometry = makeGeometry()
    const { rerender } = renderHook(
      ({ hovered }: { hovered: boolean[] | null }) =>
        useHighlightColors({ geometry, runs: RUNS, selected: null, hovered, palette: PALETTE }),
      { initialProps: { hovered: null as boolean[] | null } },
    )

    const attribute = geometry.getAttribute('color') as THREE.BufferAttribute
    const version = attribute.version

    rerender({ hovered: hoverFlags(2) })

    expect(geometry.getAttribute('color')).toBe(attribute)  // same GL buffer
    expect(attribute.version).toBeGreaterThan(version)
    // Face 2 only: 20 triangles x 9 floats, contiguous, so a single range.
    expect(attribute.updateRanges).toEqual([{ start: 2 * TRIS_PER_FACE * 9, count: TRIS_PER_FACE * 9 }])
    expect(colorAt(attribute, firstVertexOf(2))).toEqual(f32(PALETTE.hovered))
    expect(colorAt(attribute, 0)).toEqual(f32(PALETTE.base))
  })

  it('does not mark the attribute dirty when the pointer stays on the same face', () => {
    const geometry = makeGeometry()
    const { rerender } = renderHook(
      ({ hovered }: { hovered: boolean[] }) =>
        useHighlightColors({ geometry, runs: RUNS, selected: null, hovered, palette: PALETTE }),
      { initialProps: { hovered: hoverFlags(1) } },
    )
    const attribute = geometry.getAttribute('color') as THREE.BufferAttribute
    attribute.clearUpdateRanges()
    const version = attribute.version

    // A fresh array with the same content: what a re-render of an unchanged hover
    // hands the hook.
    rerender({ hovered: hoverFlags(1) })

    expect(attribute.version).toBe(version)
    expect(attribute.updateRanges).toEqual([])
  })

  it('paints selection over hover and returns the face to base when the hover leaves', () => {
    const geometry = makeGeometry()
    const { rerender } = renderHook(
      ({ hovered, selected }: { hovered: boolean[] | null; selected: boolean[] | null }) =>
        useHighlightColors({ geometry, runs: RUNS, selected, hovered, palette: PALETTE }),
      { initialProps: { hovered: hoverFlags(3) as boolean[] | null, selected: null as boolean[] | null } },
    )
    const attribute = geometry.getAttribute('color') as THREE.BufferAttribute
    expect(colorAt(attribute, firstVertexOf(3))).toEqual(f32(PALETTE.hovered))

    rerender({ hovered: hoverFlags(3), selected: hoverFlags(3) })
    expect(colorAt(attribute, firstVertexOf(3))).toEqual(f32(PALETTE.selected))

    rerender({ hovered: null, selected: null })
    expect(colorAt(attribute, firstVertexOf(3))).toEqual(f32(PALETTE.base))
  })

  it('is inert on a geometry with no colour attribute', () => {
    const geometry = new THREE.BufferGeometry()
    expect(() => renderHook(() => useHighlightColors({
      geometry, runs: RUNS, selected: null, hovered: hoverFlags(0), palette: PALETTE,
    }))).not.toThrow()
  })
})

/** The palette colour as it survives a round trip through the Float32 buffer. */
function f32(rgb: readonly [number, number, number]): number[] {
  return [...Float32Array.from(rgb)]
}

/** First vertex of a face, given each of its triangles owns three vertices. */
function firstVertexOf(face: number): number {
  return face * TRIS_PER_FACE * 3
}

/** The RGB of one vertex of the colour attribute. */
function colorAt(attribute: THREE.BufferAttribute, vertex: number): number[] {
  const array = attribute.array as Float32Array
  return [array[vertex * 3], array[vertex * 3 + 1], array[vertex * 3 + 2]]
}
