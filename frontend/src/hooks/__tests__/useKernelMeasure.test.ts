// @vitest-environment jsdom
//
// The kernel half of the readout, against a fake client: the debounce, the
// generation/pick key, and the rule that a refusal reads nothing. The worker
// itself is covered by measureGenerationReal and the actor suites; what is
// tested here is that a reply can never be rendered against a selection it was
// not asked for.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockMeasure } = vi.hoisted(() => ({ mockMeasure: vi.fn() }))

vi.mock('@/kernel/worker/solverClient', () => ({
  measureViaWorker: mockMeasure,
}))

import { MEASURE_DEBOUNCE_MS, useKernelMeasure } from '@/hooks/useKernelMeasure'
import type { KernelMeasureAsk } from '@/utils/measure/measureSelection'
import type { MeasureReply } from '@/kernel/worker/solverClient'

const PART_PAIR: KernelMeasureAsk = {
  op: 'clearance',
  picks: [{ bodyId: 'b1', kind: 'body' }, { bodyId: 'b2', kind: 'body' }],
}

const SPLINE: KernelMeasureAsk = {
  op: 'length',
  picks: [{ bodyId: 'b1', kind: 'edge', index: 3 }],
}

/** Wait past the debounce and let the resolved promises flush. */
async function afterDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, MEASURE_DEBOUNCE_MS + 30))
  })
}

describe('useKernelMeasure', () => {
  beforeEach(() => {
    mockMeasure.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends nothing for a null ask', async () => {
    const { result } = renderHook(() => useKernelMeasure(null, 'boot:1', 'final'))
    await afterDebounce()
    expect(mockMeasure).not.toHaveBeenCalled()
    expect(result.current).toEqual({ pending: false, lines: [] })
  })

  it('sends nothing while the solve has no generation', async () => {
    const { result } = renderHook(() => useKernelMeasure(PART_PAIR, null, 'final'))
    await afterDebounce()
    expect(mockMeasure).not.toHaveBeenCalled()
    expect(result.current).toEqual({ pending: false, lines: [] })
  })

  it('reserves an empty row while measuring, then renders the reply', async () => {
    let resolveReply!: (reply: MeasureReply | null) => void
    mockMeasure.mockImplementation(() => new Promise((resolve) => { resolveReply = resolve }))
    const { result } = renderHook(() => useKernelMeasure(PART_PAIR, 'boot:1', 'final'))

    // The reserved row exists from the first render, before the debounce fires.
    expect(result.current).toEqual({ pending: true, lines: [] })
    await afterDebounce()
    expect(mockMeasure).toHaveBeenCalledTimes(1)
    expect(result.current).toEqual({ pending: true, lines: [] })

    await act(async () => {
      resolveReply({ value: 12.5, points: [[0, 0, 0], [1, 1, 1]] })
    })
    expect(result.current).toEqual({ pending: false, lines: ['clearance 12.500 mm'] })
  })

  it('states why a clearance reads 0', async () => {
    mockMeasure.mockResolvedValue({ value: 0, note: 'touching' })
    const { result } = renderHook(() => useKernelMeasure(PART_PAIR, 'boot:1', 'final'))
    await afterDebounce()
    expect(result.current.lines).toEqual(['clearance 0.000 mm (touching)'])
  })

  it('reads the document unit in the suffix and a length as a length', async () => {
    mockMeasure.mockResolvedValue({ value: 2 })
    const { result } = renderHook(() => useKernelMeasure(SPLINE, 'boot:1', 'final', 'inch'))
    await afterDebounce()
    expect(result.current.lines).toEqual(['length 2.000 in'])
  })

  it('sends one request for a selection that changes rapidly inside the debounce', async () => {
    mockMeasure.mockResolvedValue({ value: 1 })
    const { rerender } = renderHook(
      ({ ask }: { ask: KernelMeasureAsk }) => useKernelMeasure(ask, 'boot:1', 'final'),
      { initialProps: { ask: PART_PAIR } },
    )
    // A sweep: each of these lands inside the same debounce window.
    rerender({ ask: { op: 'clearance', picks: [{ bodyId: 'b1', kind: 'body' }, { bodyId: 'b3', kind: 'body' }] } })
    rerender({ ask: { op: 'clearance', picks: [{ bodyId: 'b1', kind: 'body' }, { bodyId: 'b4', kind: 'body' }] } })
    rerender({ ask: SPLINE })
    await afterDebounce()
    expect(mockMeasure).toHaveBeenCalledTimes(1)
    expect(mockMeasure.mock.calls[0][0]).toMatchObject({ op: 'length', picks: SPLINE.picks })
  })

  it('drops a reply for a generation the selection has moved past', async () => {
    let resolveOld!: (reply: MeasureReply | null) => void
    mockMeasure.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    const { result, rerender } = renderHook(
      ({ generation }: { generation: string }) => useKernelMeasure(PART_PAIR, generation, 'final'),
      { initialProps: { generation: 'boot:1' } },
    )
    await afterDebounce()
    expect(mockMeasure).toHaveBeenCalledTimes(1)

    // A newer solve landed while the request was in flight.
    mockMeasure.mockResolvedValue({ value: 99 })
    rerender({ generation: 'boot:2' })
    await act(async () => {
      resolveOld({ value: 1 })
    })
    // The old reply is dropped, and the new generation's own request is what
    // fills the row.
    await afterDebounce()
    expect(result.current.lines).toEqual(['clearance 99.000 mm'])
  })

  it('drops a reply for a pick set the selection has moved past', async () => {
    let resolveOld!: (reply: MeasureReply | null) => void
    mockMeasure.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    const { result, rerender } = renderHook(
      ({ ask }: { ask: KernelMeasureAsk }) => useKernelMeasure(ask, 'boot:1', 'final'),
      { initialProps: { ask: PART_PAIR } },
    )
    await afterDebounce()

    const other: KernelMeasureAsk = {
      op: 'distance',
      picks: [{ bodyId: 'b1', kind: 'face', index: 0 }, { bodyId: 'b2', kind: 'face', index: 1 }],
    }
    mockMeasure.mockResolvedValue({ value: 4 })
    rerender({ ask: other })
    await act(async () => {
      resolveOld({ value: 1 })
    })
    await afterDebounce()
    expect(result.current.lines).toEqual(['distance 4.000 mm'])
  })

  it('reads nothing for a refusal or a dead worker', async () => {
    mockMeasure.mockRejectedValueOnce(new Error('measure stale'))
    const { result } = renderHook(() => useKernelMeasure(PART_PAIR, 'boot:1', 'final'))
    expect(result.current).toEqual({ pending: true, lines: [] })
    await afterDebounce()
    // A refused ask releases the reserved row instead of showing an error or
    // holding an empty line open forever.
    expect(result.current).toEqual({ pending: false, lines: [] })
  })

  it('reads nothing when there is no worker to answer', async () => {
    mockMeasure.mockResolvedValueOnce(null)
    const { result } = renderHook(() => useKernelMeasure(PART_PAIR, 'boot:1', 'final'))
    await afterDebounce()
    expect(result.current).toEqual({ pending: false, lines: [] })
  })
})
