// The angular dimension's editor glyph is a sibling of constraint_dimension,
// not a reuse of the angle constraint's tile symbol: the two constraints draw a
// wedge and a measured arc, and the pair must not collapse into one file.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ICONS = join(__dirname, '../../../assets/icons')
const read = (name: string) => readFileSync(join(ICONS, name), 'utf8')

describe('dimension-angle icon', () => {
  it('exists and differs from the angle and dimension constraint glyphs', () => {
    const angleDim = read('dimension-angle.svg')
    expect(angleDim).toContain('<svg')
    expect(angleDim).not.toBe(read('constraint-angle.svg'))
    expect(angleDim).not.toBe(read('constraint-dimension.svg'))
  })

  it('draws two legs and an arc with an arrowhead at each end', () => {
    const angleDim = read('dimension-angle.svg')
    // Two stroked paths (legs, arc) plus the two filled arrowhead triangles.
    expect(angleDim.match(/<path/g)?.length).toBe(4)
    expect(angleDim.match(/fill="rgb\(0%, 0%, 0%\)"/g)?.length).toBe(2)
  })
})
