import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { IdPipeline } from '../IdPipeline'

/**
 * Latest-wins coalescing: when a second resolveAsync arrives while the
 * first is still in flight, the older promise must resolve with the same
 * (newer) result. We don't want stale hover results landing late.
 */
describe('IdPipeline.resolveAsync ordering', () => {
  it('coalesces overlapping queries to the latest cursor', async () => {
    const p = new IdPipeline({ width: 32, height: 32 })

    let nextResult: { x: number; y: number } | null = null
    // Stub resolveSync (used as the fallback path when readRenderTargetPixelsAsync
    // is absent). Echo the cursor as the entityKey so we can confirm which
    // query the returned hit corresponds to.
    p.resolveSync = ((_r: unknown, cursor: { x: number; y: number }) => {
      nextResult = cursor
      return {
        id: 1, layer: 'face', entityKey: `cursor:${cursor.x},${cursor.y}`, distancePx: 0,
      }
    }) as unknown as typeof p.resolveSync

    const renderer = {} as unknown as THREE.WebGLRenderer

    const aPromise = p.resolveAsync(renderer, { x: 1, y: 1 })
    const bPromise = p.resolveAsync(renderer, { x: 9, y: 9 })

    const [aHit, bHit] = await Promise.all([aPromise, bPromise])
    // Older query resolves with the newer cursor's result.
    expect(aHit?.entityKey).toBe('cursor:9,9')
    expect(bHit?.entityKey).toBe('cursor:9,9')
    expect(nextResult).toEqual({ x: 9, y: 9 })
    p.dispose()
  })

  it('serial queries each get their own result', async () => {
    const p = new IdPipeline({ width: 32, height: 32 })
    p.resolveSync = ((_r: unknown, cursor: { x: number; y: number }) => ({
      id: 2, layer: 'face', entityKey: `cursor:${cursor.x},${cursor.y}`, distancePx: 0,
    })) as unknown as typeof p.resolveSync

    const renderer = {} as unknown as THREE.WebGLRenderer
    const a = await p.resolveAsync(renderer, { x: 1, y: 1 })
    const b = await p.resolveAsync(renderer, { x: 9, y: 9 })
    expect(a?.entityKey).toBe('cursor:1,1')
    expect(b?.entityKey).toBe('cursor:9,9')
    p.dispose()
  })

  // A query that arrives after the head read has already started (between the
  // two microtasks the deferral is built from) is not dropped and not folded
  // into the head: it becomes the NEXT read, so its own cursor is answered
  // rather than the head's. done() drains that queue.
  it('runs a query that arrives while the head read is executing as the next read', async () => {
    const p = new IdPipeline({ width: 32, height: 32 })
    p.resolveSync = ((_r: unknown, cursor: { x: number; y: number }) => ({
      id: 1, layer: 'face', entityKey: `cursor:${cursor.x},${cursor.y}`, distancePx: 0,
    })) as unknown as typeof p.resolveSync
    const renderer = {} as unknown as THREE.WebGLRenderer

    const a = p.resolveAsync(renderer, { x: 1, y: 1 })
    await Promise.resolve()  // the head read is now in flight; inFlightAsync is set
    const b = p.resolveAsync(renderer, { x: 2, y: 2 })  // lands on nextAsync

    expect((await a)?.entityKey).toBe('cursor:1,1')
    expect((await b)?.entityKey).toBe('cursor:2,2')
    p.dispose()
  })

  it('does not trigger renders by itself', async () => {
    const p = new IdPipeline({ width: 32, height: 32 })
    p.resolveSync = (() => null) as unknown as typeof p.resolveSync
    const renderer = {} as unknown as THREE.WebGLRenderer

    const before = p.getRenderCount()
    for (let i = 0; i < 50; i++) {
      // Don't await, fire-and-forget like a hover stream.
      void p.resolveAsync(renderer, { x: i, y: i })
    }
    // Drain microtasks.
    await new Promise(r => setTimeout(r, 0))
    expect(p.getRenderCount()).toBe(before)
    p.dispose()
  })

  // A read through a disposed target can only answer "nothing"; the throw
  // mimics what a real renderer does reading through torn-down GL objects,
  // so pre-fix these subscriber promises never settled at all.
  function pipelineWhoseReadsThrow(): { p: IdPipeline; renderer: THREE.WebGLRenderer } {
    const p = new IdPipeline({ width: 32, height: 32 })
    p.resolveSync = (() => { throw new Error('read through disposed target') }) as unknown as typeof p.resolveSync
    return { p, renderer: {} as unknown as THREE.WebGLRenderer }
  }

  it('settles every pending async resolve with null when disposed mid-flight', async () => {
    const { p, renderer } = pipelineWhoseReadsThrow()

    const first = p.resolveAsync(renderer, { x: 1, y: 1 })   // becomes the in-flight query
    const second = p.resolveAsync(renderer, { x: 2, y: 2 })  // coalesces into the queued query
    p.dispose()

    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toBeNull()
  })

  it('resolveAsync after dispose resolves null instead of scheduling work', async () => {
    const { p, renderer } = pipelineWhoseReadsThrow()
    p.dispose()
    await expect(p.resolveAsync(renderer, { x: 3, y: 3 })).resolves.toBeNull()
  })

  // H3: a throwing readback with NO preceding dispose used to wedge the async
  // hover path forever: done() never ran, inFlightAsync stayed set, and every
  // later resolveAsync leaked a never-settled promise onto nextAsync.
  it('a throwing resolveSync settles the caller with null and frees the queue', async () => {
    const { p, renderer } = pipelineWhoseReadsThrow()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const first = p.resolveAsync(renderer, { x: 1, y: 1 })
      const second = p.resolveAsync(renderer, { x: 2, y: 2 })  // coalesces behind first
      await expect(first).resolves.toBeNull()
      await expect(second).resolves.toBeNull()
      expect(warn).toHaveBeenCalledWith('ID async resolve read failed', expect.any(Error))

      // The path is not wedged: a fresh resolve runs and settles too.
      p.resolveSync = ((_r: unknown, cursor: { x: number; y: number }) => ({
        id: 1, layer: 'face', entityKey: `cursor:${cursor.x},${cursor.y}`, distancePx: 0,
      })) as unknown as typeof p.resolveSync
      await expect(p.resolveAsync(renderer, { x: 5, y: 5 }))
        .resolves.toMatchObject({ entityKey: 'cursor:5,5' })
    } finally {
      warn.mockRestore()
      p.dispose()
    }
  })
})
