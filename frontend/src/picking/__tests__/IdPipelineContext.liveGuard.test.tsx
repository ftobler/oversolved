// setLivePipeline's disposed-pipeline canary: republishing a disposed instance
// would leave the async resolve path permanently deaf, so the write must be
// refused and the live slot untouched. failLoud throws in test mode.
import { describe, it, expect, afterEach } from 'vitest'
import { IdPipeline } from '../IdPipeline'
import { setLivePipeline, getLivePipeline } from '../IdPipelineContext'

describe('setLivePipeline disposed guard', () => {
  afterEach(() => setLivePipeline(null))

  it('publishes a live pipeline', () => {
    const p = new IdPipeline({ width: 16, height: 16 })
    setLivePipeline(p)
    expect(getLivePipeline()).toBe(p)
    p.dispose()
  })

  it('refuses a disposed pipeline and leaves the live one in place', () => {
    const live = new IdPipeline({ width: 16, height: 16 })
    setLivePipeline(live)

    const dead = new IdPipeline({ width: 16, height: 16 })
    dead.dispose()
    expect(() => setLivePipeline(dead)).toThrow(/refused a disposed/)

    expect(getLivePipeline()).toBe(live)
    live.dispose()
  })

  it('conditional publish only swaps when the expected previous matches', () => {
    const first = new IdPipeline({ width: 16, height: 16 })
    const second = new IdPipeline({ width: 16, height: 16 })
    setLivePipeline(first)

    // A stale cleanup passes the wrong previous: the write is skipped.
    setLivePipeline(second, null)
    expect(getLivePipeline()).toBe(first)

    setLivePipeline(second, first)
    expect(getLivePipeline()).toBe(second)
    first.dispose()
    second.dispose()
  })
})
