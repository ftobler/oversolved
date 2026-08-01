import { describe, it, expect } from 'vitest'
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
})
