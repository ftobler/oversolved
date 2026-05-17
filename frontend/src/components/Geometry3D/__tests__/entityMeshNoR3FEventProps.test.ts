import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * 267.4 / 267.5 cutover: Body3D, EntityLines, VertexDots, ReferencePlane,
 * UserDefinedPlane, and OriginMarker meshes have zero R3F event props.
 * The id-buffer dispatcher is now the sole pick source for all layers.
 */

const GEOM3D_DIR = join(__dirname, '..')
const VIEWPORT_DIR = join(__dirname, '../../Viewport')
const FORBIDDEN = ['onPointerOver', 'onPointerOut', 'onPointerDown', 'onClick']

function assertNoForbiddenProps(src: string, element: string, file: string): void {
  const tagRegex = new RegExp(`<${element}\\b[^>]*>`, 'g')
  const tags = src.match(tagRegex) ?? []
  for (const tag of tags) {
    for (const prop of FORBIDDEN) {
      expect(tag, `${file}: forbidden ${prop} on ${element}: ${tag}`).not.toContain(prop)
    }
  }
}

describe('Body3D meshes have no R3F event props', () => {
  it('Body3D.tsx has no event props on <mesh>', () => {
    assertNoForbiddenProps(readFileSync(join(GEOM3D_DIR, 'Body3D.tsx'), 'utf8'), 'mesh', 'Body3D')
  })
  it('Body3D.tsx has no event props on <lineSegments>', () => {
    assertNoForbiddenProps(readFileSync(join(GEOM3D_DIR, 'Body3D.tsx'), 'utf8'), 'lineSegments', 'Body3D')
  })
  it('Body3D.tsx has no event props on <instancedMesh>', () => {
    assertNoForbiddenProps(readFileSync(join(GEOM3D_DIR, 'Body3D.tsx'), 'utf8'), 'instancedMesh', 'Body3D')
  })
})

describe('VertexDots.tsx has no R3F event props', () => {
  const src = readFileSync(join(GEOM3D_DIR, 'VertexDots.tsx'), 'utf8')
  it('<group> has no event props', () => {
    assertNoForbiddenProps(src, 'group', 'VertexDots')
  })
  it('<mesh> has no event props', () => {
    assertNoForbiddenProps(src, 'mesh', 'VertexDots')
  })
})

describe('EntityLines.tsx has no R3F event props', () => {
  const src = readFileSync(join(GEOM3D_DIR, 'EntityLines.tsx'), 'utf8')
  it('<group> has no event props', () => {
    assertNoForbiddenProps(src, 'group', 'EntityLines')
  })
  it('does not import or use HitPolyline (removed 267.6)', () => {
    expect(src).not.toContain('HitPolyline')
  })
})

describe('ReferencePlane / UserDefinedPlane / OriginMarker have no R3F event props', () => {
  it('ReferencePlane.tsx does not pass event props to PlaneSurface', () => {
    const src = readFileSync(join(VIEWPORT_DIR, 'ReferencePlane.tsx'), 'utf8')
    for (const prop of FORBIDDEN) {
      expect(src, `ReferencePlane: should not contain ${prop}=`).not.toContain(`${prop}=`)
    }
  })
  it('UserDefinedPlane.tsx does not pass event props to PlaneSurface', () => {
    const src = readFileSync(join(VIEWPORT_DIR, 'UserDefinedPlane.tsx'), 'utf8')
    for (const prop of FORBIDDEN) {
      expect(src, `UserDefinedPlane: should not contain ${prop}=`).not.toContain(`${prop}=`)
    }
  })
  it('OriginMarker.tsx has no event props on <group>', () => {
    assertNoForbiddenProps(readFileSync(join(VIEWPORT_DIR, 'OriginMarker.tsx'), 'utf8'), 'group', 'OriginMarker')
  })
})
