import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * 267.4 cutover: Body3D meshes have zero R3F event props.
 * The id-buffer dispatcher is now the sole pick source for B-rep
 * face / edge / vertex layers.
 */

const BODY3D_DIR = join(__dirname, '..')
const FORBIDDEN = ['onPointerOver', 'onPointerOut', 'onPointerDown', 'onClick']

describe('Body3D meshes have no R3F event props', () => {
  it('Body3D.tsx has no onPointerOver/Out/Click on any <mesh>', () => {
    const src = readFileSync(join(BODY3D_DIR, 'Body3D.tsx'), 'utf8')
    const meshTags = src.match(/<mesh\b[^>]*>/g) ?? []
    for (const tag of meshTags) {
      for (const prop of FORBIDDEN) {
        expect(tag, `forbidden ${prop} on mesh: ${tag}`).not.toContain(prop)
      }
    }
  })

  it('Body3D.tsx has no onPointerOver/Out/Click on any <lineSegments>', () => {
    const src = readFileSync(join(BODY3D_DIR, 'Body3D.tsx'), 'utf8')
    const lineTags = src.match(/<lineSegments\b[^>]*>/g) ?? []
    for (const tag of lineTags) {
      for (const prop of FORBIDDEN) {
        expect(tag, `forbidden ${prop} on lineSegments: ${tag}`).not.toContain(prop)
      }
    }
  })

  it('Body3D.tsx has no onPointerOver/Out/Click on any <instancedMesh>', () => {
    const src = readFileSync(join(BODY3D_DIR, 'Body3D.tsx'), 'utf8')
    const instTags = src.match(/<instancedMesh\b[^>]*>/g) ?? []
    for (const tag of instTags) {
      for (const prop of FORBIDDEN) {
        expect(tag, `forbidden ${prop} on instancedMesh: ${tag}`).not.toContain(prop)
      }
    }
  })
})
