import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import {
  HighlightColorPainter, uploadPaint,
  type HighlightPalette, type PrimitiveRuns, type RGB,
} from './highlightColorPainter'

/**
 * Drive a geometry's existing `color` attribute from highlight flags, repainting
 * only what changed.
 *
 * The attribute itself is never replaced: it is created once with the geometry
 * and mutated in place. That is the whole point -- a new BufferAttribute per
 * hover means a new GL buffer and a full re-upload of the body's colour data on
 * every pointer move, which is minutes-per-hover territory on an imported solid.
 *
 * `selected` and `hovered` are indexed by primitive (see `runs`); pass null for
 * "nothing", which is also how a non-interactive body renders flat.
 */
export function useHighlightColors(params: {
  geometry: THREE.BufferGeometry
  runs: PrimitiveRuns
  selected: readonly boolean[] | null
  hovered: readonly boolean[] | null
  palette: HighlightPalette
}): void {
  const { geometry, runs, selected, hovered, palette } = params

  const painter = useMemo(() => {
    const array = colorAttribute(geometry)?.array
    if (!(array instanceof Float32Array)) return null
    return new HighlightColorPainter(array, runs)
  }, [geometry, runs])

  useEffect(() => {
    const attribute = colorAttribute(geometry)
    if (!painter || !attribute) return
    uploadPaint(attribute, painter.apply(selected, hovered, palette))
  }, [painter, geometry, selected, hovered, palette])
}

/** The geometry's colour attribute, or null when it has none (or an interleaved
 *  one, which this path never builds). */
function colorAttribute(geometry: THREE.BufferGeometry): THREE.BufferAttribute | null {
  const attribute = geometry.getAttribute('color')
  return attribute instanceof THREE.BufferAttribute ? attribute : null
}

/** Hex string -> the RGB triple the painter writes. Parsed once per palette, not
 *  once per primitive. */
export function paletteRGB(hex: string): RGB {
  const { r, g, b } = new THREE.Color(hex)
  return [r, g, b]
}
