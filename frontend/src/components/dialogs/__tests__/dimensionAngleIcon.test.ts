// The angular dimension's editor glyph is a sibling of constraint_dimension,
// not a reuse of the angle constraint's tile symbol: the two constraints draw a
// wedge and a measured arc, and the pair must not collapse into one file.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TOOL_DEFS } from '../../Toolbar/tools/toolsConfig'
import { DIMENSION_TOOL_ICON } from '../../../registry/constraintRegistry'

const ICONS = join(__dirname, '../../../assets/icons')
const read = (name: string) => readFileSync(join(ICONS, name), 'utf8')

describe('dimension-angle icon', () => {
  it('keeps the editor fallback in step with the toolbar glyph', () => {
    // The store cannot import the component tree, so the registry carries the
    // name; this pin is what keeps the two from drifting apart.
    expect(DIMENSION_TOOL_ICON).toBe(TOOL_DEFS.dimension.icon)
  })
  it('exists and differs from the angle and dimension constraint glyphs', () => {
    const angleDim = read('dimension-angle.svg')
    expect(angleDim).toContain('<svg')
    expect(angleDim).not.toBe(read('constraint-angle.svg'))
    expect(angleDim).not.toBe(read('constraint-dimension.svg'))
  })

  it('draws two legs and an arc with an arrowhead at each end', () => {
    const angleDim = read('dimension-angle.svg')
    // The measured legs are one polyline; the dimension line is the cubic arc;
    // the two filled triangles are the heads. Assert the parts rather than a
    // path count, so a later second stroke on a leg does not break the test.
    expect(angleDim).toMatch(/fill="none"[^>]*d="M [^"]+ L [^"]+ L [^"]+"/)
    expect(angleDim).toMatch(/fill="none"[^>]*d="M [^"]+ C /)
    expect(angleDim.match(/fill="rgb\(0%, 0%, 0%\)"/g)).toHaveLength(2)
  })
})
