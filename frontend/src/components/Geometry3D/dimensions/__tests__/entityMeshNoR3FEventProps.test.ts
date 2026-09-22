import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * 267.3 cutover: dimension label hit meshes have no R3F event props.
 * The id-buffer dispatcher (267.2) is now the sole pick source for
 * dimension labels.
 *
 * The hit mesh lives in DimensionLabel.tsx (and the arrow primitives in
 * primitives.tsx), so the scan walks every .tsx in the directory rather than a
 * hand-picked list that can go stale and leave the guard passing vacuously.
 */

const DIM_DIR = join(__dirname, '..')
const FORBIDDEN = ['onPointerOver', 'onPointerOut', 'onPointerDown', 'onClick']

// Extract complete `<mesh ...>` tags. A tag may span lines and may contain a
// `>` inside a `{...}` attribute expression (an arrow function, a comparison),
// so brace depth decides when the tag really ends.
function meshTags(src: string): string[] {
  const tags: string[] = []
  const open = /<mesh\b/g
  let match: RegExpExecArray | null
  while ((match = open.exec(src)) !== null) {
    let depth = 0
    let i = match.index
    for (; i < src.length; i++) {
      const ch = src[i]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      else if (ch === '>' && depth === 0) break
    }
    tags.push(src.slice(match.index, i + 1))
  }
  return tags
}

describe('meshTags matcher', () => {
  it('captures a multiline tag whose attribute expression contains `>`', () => {
    const src = [
      '<mesh',
      '  position={[x, y, 0]}',
      '  onPointerOver={() => setHover(true)}',
      '>',
      '  <boxGeometry />',
      '</mesh>',
    ].join('\n')
    expect(meshTags(src)).toEqual([
      '<mesh\n  position={[x, y, 0]}\n  onPointerOver={() => setHover(true)}\n>',
    ])
  })
})

describe('dimension label meshes have no R3F event props', () => {
  const files = readdirSync(DIM_DIR).filter(f => f.endsWith('.tsx')).sort()
  for (const f of files) {
    it(`${f} has no onPointerOver/Out/Down/onClick on any <mesh>`, () => {
      const src = readFileSync(join(DIM_DIR, f), 'utf8')
      const tags = meshTags(src)
      // A file that mentions `<mesh` must yield tags, or the matcher is silently
      // passing and the guard is vacuous.
      if (src.includes('<mesh')) expect(tags.length).toBeGreaterThan(0)
      for (const tag of tags) {
        for (const prop of FORBIDDEN) {
          expect(tag, `${f}: forbidden ${prop} on mesh: ${tag}`).not.toContain(prop)
        }
      }
    })
  }
})
