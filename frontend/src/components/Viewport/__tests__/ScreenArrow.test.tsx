// The shared editing arrow: one screen-sized head, an optional world-sized tail,
// and content pinned to the tip. Both the feature handles and the section plane
// draw through it, so the proportions are pinned here once.
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ScreenArrow, { CONE_LEN, SHAFT_END, SHAFT_START } from '@/components/Viewport/ScreenArrow'

describe('ScreenArrow', () => {
  it('draws a shaft and a cone in the head, and nothing else', () => {
    const { container } = render(<ScreenArrow color="#ff0000" />)
    expect(container.querySelectorAll('mesh')).toHaveLength(2)
    expect(container.querySelectorAll('cylindergeometry')).toHaveLength(1)
    expect(container.querySelectorAll('conegeometry')).toHaveLength(1)
    expect(container.querySelector('meshbasicmaterial')?.getAttribute('color')).toBe('#ff0000')
  })

  it('spans the screen-space head from its start to the cone base', () => {
    const { container } = render(<ScreenArrow color="#ff0000" />)
    // args are cylinder(R, R, height, segments); the head runs SHAFT_START..SHAFT_END.
    expect(container.querySelector('cylindergeometry')?.getAttribute('args'))
      .toBe(`1.6,1.6,${SHAFT_END - SHAFT_START},12`)
    expect(container.querySelector('conegeometry')?.getAttribute('args'))
      .toBe(`5.5,${CONE_LEN},16`)
  })

  it('starts the shaft at the grab point when a tail is drawn', () => {
    const { container } = render(<ScreenArrow color="#ff0000" tailLength={5} headStartPx={0} />)
    expect(container.querySelectorAll('mesh')).toHaveLength(3)
    // The first cylinder is the tail's unit primitive; the head's follows it.
    expect(container.querySelectorAll('cylindergeometry')[1]?.getAttribute('args'))
      .toBe(`1.6,1.6,${SHAFT_END},12`)
  })

  it('positions the world-sized tail behind the grab point', () => {
    const { container } = render(<ScreenArrow color="#ff0000" tailLength={5} pixelsPerWorld={2} />)
    const tail = container.querySelector('mesh')!
    expect(tail.getAttribute('position')).toBe('0,-2.5,0')
    expect(tail.getAttribute('scale')).toBe('3.2,5,3.2')
  })

  it('draws no tail at zero length, so the tailless arrow has two meshes', () => {
    const { container } = render(<ScreenArrow color="#ff0000" tailLength={0} />)
    expect(container.querySelectorAll('mesh')).toHaveLength(2)
  })

  it('renders content inside the screen-sized head', () => {
    const { container, getByText } = render(
      <ScreenArrow color="#fff"><span>value</span></ScreenArrow>,
    )
    expect(getByText('value')).not.toBeNull()
    expect(container.querySelector('group span')).not.toBeNull()
  })

  it('is the single arrow both viewport handles draw', () => {
    // A second copy is the regression this extraction removes: the section
    // arrow and the feature handles must go through the shared component and
    // the shared axis math, not build their own meshes again.
    for (const file of ['SectionPlaneHandle.tsx', 'FeatureHandles.tsx']) {
      const src = readFileSync(join(__dirname, '..', file), 'utf8')
      expect(src, file).toMatch(/from '@\/components\/Viewport\/ScreenArrow'/)
      expect(src, file).toMatch(/useAxisDrag/)
      expect(src, file).not.toMatch(/cylinderGeometry|coneGeometry/)
    }
  })
})
