import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import type { Mesh3D } from '@/types/cad'
import type { LazyGeometryCache } from '@/components/Geometry3D/lazyGeometryCache'
import { buildFaceBoundarySegments } from '@/utils/partGeometry'
import { useEditorState } from '@/hooks/useEditorState'

/**
 * The face hover outline at the component seam: a solved cylinder's lateral
 * face is a periodic face whose mesh repeats the seam column, so the outline
 * must be the two rims and nothing down the seam. Hover and selection share the
 * one overlay recipe, and this pins that they draw the same welded geometry.
 */

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

// Capture the geometry caches Part3D hands the overlay rather than reading a
// three.js object out of jsdom, where the overlay host elements have no scene.
const { overlays } = vi.hoisted(() => ({
  overlays: [] as { geos: unknown; active: boolean }[],
}))

vi.mock('@/components/Geometry3D/highlightOverlay', () => ({
  HighlightOverlays: (props: { geos: unknown; active: boolean }) => {
    overlays.push({ geos: props.geos, active: props.active })
    return null
  },
}))

const LAT = 0
const BOTTOM = 1
const TOP = 2

/**
 * A closed cylinder with a 4-segment lateral face. The seam column is emitted
 * twice (indices 0 and 4 on each ring) at the same 3D point, as OCC's UV
 * tessellation of a periodic face does. The caps are separate faces.
 */
function cylinderMesh(): Mesh3D {
  const columns = 4
  const vertices: [number, number, number][] = []
  for (const z of [0, 1]) {
    for (let i = 0; i <= columns; i++) {
      const angle = ((i === columns ? 0 : i) / columns) * 2 * Math.PI
      vertices.push([Math.cos(angle), Math.sin(angle), z])
    }
  }
  const bottomCentre = vertices.length
  vertices.push([0, 0, 0])
  const topCentre = vertices.length
  vertices.push([0, 0, 1])
  const bottom = (i: number) => i
  const top = (i: number) => columns + 1 + i
  const faces: [number, number, number][] = []
  const triangle_to_face: number[] = []
  for (let i = 0; i < columns; i++) {
    faces.push([bottom(i), bottom(i + 1), top(i)], [bottom(i + 1), top(i + 1), top(i)])
    triangle_to_face.push(LAT, LAT)
  }
  for (let i = 0; i < columns; i++) {
    faces.push([bottomCentre, bottom(i + 1), bottom(i)])
    triangle_to_face.push(BOTTOM)
  }
  for (let i = 0; i < columns; i++) {
    faces.push([topCentre, top(i), top(i + 1)])
    triangle_to_face.push(TOP)
  }
  return { vertices, faces, triangle_to_face, face_queries: ['?lat', '?bottom', '?top'] }
}

const MESH = cylinderMesh()

function resetStore(overrides: Record<string, unknown> = {}) {
  useEditorState.setState({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    hoveredSelectionId: null,
    hoveredPickKey: null,
    ...overrides,
  } as never)
}

async function renderPart() {
  const { default: Part3D } = await import('@/components/Geometry3D/Part3D')
  return render(
    <Part3D featureId="cyl1" partId="body_cyl1" mesh={MESH} edges={[]} edgeQueries={[]} />,
  )
}

/** The overlay built over face outlines: the only capture with a geometry cache. */
function lateralGeometry(): { count: number; floats: ArrayLike<number> } {
  const overlay = overlays.find(o => o.geos !== null && o.active)
  expect(overlay, 'no active face overlay').toBeDefined()
  const geometry = (overlay!.geos as LazyGeometryCache).get(LAT)
  expect(geometry).not.toBeNull()
  const position = geometry!.getAttribute('position')
  return { count: position.count, floats: position.array }
}

/** Segments the two caps' rims contribute, in vertices. */
function capRimVertices(): number {
  return (buildFaceBoundarySegments(MESH, BOTTOM).length
    + buildFaceBoundarySegments(MESH, TOP).length) / 3
}

beforeEach(() => {
  overlays.length = 0
  resetStore()
})

describe('Part3D face outline seam', () => {
  const FIRST_MOUNT_TIMEOUT = 15_000

  it('hovers a cylinder lateral face with exactly the two rims', async () => {
    resetStore({ hoveredSelectionId: '?lat' })
    await renderPart()

    const { count, floats } = lateralGeometry()
    // 4 rim segments per cap, 2 vertices each: the same count the caps own.
    expect(count).toBe(capRimVertices())
    // No segment runs down the seam column; every segment stays on one rim.
    for (let i = 0; i < floats.length; i += 6) {
      expect(Math.abs(floats[i + 2] - floats[i + 5])).toBeLessThan(1e-9)
    }
  }, FIRST_MOUNT_TIMEOUT)

  it('draws a selected lateral face with the same welded outline', async () => {
    resetStore({ normalSelection: new Set(['?lat']) })
    await renderPart()

    expect(lateralGeometry().count).toBe(capRimVertices())
  })
})
