import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * 267.3 cutover: dimension label hit meshes have no R3F event props.
 * The id-buffer dispatcher (267.2) is now the sole pick source for
 * dimension labels.
 *
 * Expanded by 267.7 to also cover EntityLines / VertexDots / Body3D.
 */

const DIM_DIR = join(__dirname, '..')
const FORBIDDEN = ['onPointerOver', 'onPointerOut', 'onPointerDown', 'onClick']

const files = ['Linear.tsx', 'Radial.tsx', 'Angle.tsx']

describe('dimension label meshes have no R3F event props', () => {
  for (const f of files) {
    it(`${f} has no onPointerOver/Out/Down/onClick on any <mesh>`, () => {
      const src = readFileSync(join(DIM_DIR, f), 'utf8')
      // Look for `<mesh ...>` tags; assert none mention the forbidden props.
      const meshTags = src.match(/<mesh\b[^>]*>/g) ?? []
      for (const tag of meshTags) {
        for (const prop of FORBIDDEN) {
          expect(tag, `${f}: forbidden ${prop} on mesh: ${tag}`).not.toContain(prop)
        }
      }
    })
  }
})
