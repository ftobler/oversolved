import { describe, it, expect } from 'vitest'
import type { ReactElement } from 'react'
import { renderDimension } from '../renderDimension'
import type { DimInteractionBase } from '../renderDimension'
import { LinearDimension } from '../Linear'
import { RadiusDimension, DiameterDimension } from '../Radial'
import { AngleDimension } from '../Angle'

/**
 * renderDimension is the shared switch mapping a constraint render block to its
 * dimension component. It is pure (element construction only), so these tests
 * read the returned element's type, key and props rather than mounting R3F.
 */

const BASE: DimInteractionBase = { featureId: 'S1', entityId: 'L1' }

interface DimElementProps {
  interaction?: { promptLabel?: string }
  cid?: string
  dim?: { kind: string }
  dimOffset?: number
}

function element(result: ReturnType<typeof renderDimension>): ReactElement<DimElementProps> {
  expect(result).not.toBeNull()
  return result as ReactElement<DimElementProps>
}

describe('renderDimension dispatch', () => {
  it('maps dim_linear to LinearDimension with the dimension prompt and passes dimOffset through', () => {
    const dim = { kind: 'dim_linear', p1: [0, 0], p2: [1, 0], normal: [0, 1], value: 1 }
    const el = element(renderDimension('c1', dim, 12, BASE))

    expect(el.type).toBe(LinearDimension)
    expect(el.key).toBe('c1')
    expect(el.props).toMatchObject({
      cid: 'c1', dim, dimOffset: 12,
      interaction: { featureId: 'S1', entityId: 'L1', constraintId: 'c1', promptLabel: 'dimension' },
    })
  })

  it('maps dim_radius and dim_diameter with their own prompt labels', () => {
    const radius = { kind: 'dim_radius', p1: [0, 0], p2: [1, 0], value: 1 }
    const radiusEl = element(renderDimension('r1', radius, 10, BASE))
    expect(radiusEl.type).toBe(RadiusDimension)
    expect(radiusEl.props.interaction?.promptLabel).toBe('radius')

    const diameter = { kind: 'dim_diameter', p1: [0, 0], p2: [1, 0], value: 1 }
    const diameterEl = element(renderDimension('d1', diameter, 10, BASE))
    expect(diameterEl.type).toBe(DiameterDimension)
    expect(diameterEl.props.interaction?.promptLabel).toBe('diameter')
  })

  it('maps dim_angle to AngleDimension', () => {
    const angle = { kind: 'dim_angle', p1: [0, 0], p2: [1, 0], p3: [0, 0], p4: [0, 1], value: 90 }
    const el = element(renderDimension('a1', angle, 10, BASE))

    expect(el.type).toBe(AngleDimension)
    expect(el.props.interaction?.promptLabel).toBe('angle in degrees')
  })

  it('returns null for a dim_angle block missing an endpoint', () => {
    const angle = { kind: 'dim_angle', p1: [0, 0], p2: [1, 0], value: 90 }

    expect(renderDimension('a1', angle, 10, BASE)).toBeNull()
  })

  it('returns null for a non-dimension block', () => {
    expect(renderDimension('x', { kind: 'symbol_horizontal', at: [0, 0] }, 10, BASE)).toBeNull()
  })
})

describe('renderDimension read-only mode', () => {
  it('omits the interaction when no base is supplied', () => {
    const dim = { kind: 'dim_linear', p1: [0, 0], p2: [1, 0], normal: [0, 1], value: 1 }
    const el = element(renderDimension('c1', dim, 10, undefined))

    expect(el.props.interaction).toBeUndefined()
  })
})
