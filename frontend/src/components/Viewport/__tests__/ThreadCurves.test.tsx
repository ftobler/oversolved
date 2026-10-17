// The cosmetic-thread display component: one polyline per reported helix, and
// nothing at all when no hole carries a thread. The drei Line is mocked, so
// this pins the component's own decision (count, keys, points) without a canvas.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import ThreadCurves from '../ThreadCurves'

const seams = vi.hoisted(() => ({ lines: vi.fn() }))

vi.mock('@react-three/drei', () => ({
  Line: (props: Record<string, unknown>) => { seams.lines(props); return null },
}))

beforeEach(() => {
  seams.lines.mockClear()
})

describe('ThreadCurves', () => {
  it('draws one line per helix with its points', () => {
    const points: [number, number, number][] = [[0, 0, 0], [1, 0, 0.5], [1, 1, 1]]
    render(
      <ThreadCurves
        curves={[
          { featureId: 'h1', points },
          { featureId: 'h2', points: [[5, 5, 0], [6, 5, 0.5]] },
        ]}
      />,
    )
    expect(seams.lines).toHaveBeenCalledTimes(2)
    expect(seams.lines.mock.calls[0][0]).toMatchObject({ points })
  })

  it('renders nothing when no hole reports a thread', () => {
    render(<ThreadCurves curves={[]} />)
    expect(seams.lines).not.toHaveBeenCalled()
  })
})
