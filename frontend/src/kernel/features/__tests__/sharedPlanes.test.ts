// resolvePlaneRef is the one plane-pick reader the mirror and split leaves
// share. These cases pin the spellings it accepts and the failure names, with
// no OCC: every input is a repo element or a bare builtin name. The
// sketch<->world frame pair is pinned as a round trip.

import { describe, it, expect } from 'vitest'
import { Repository, initGlobalRepo } from '../../query'
import { resolvePlaneRef, sketchToWorld2d, worldToSketch2d } from '../shared/planes'

function repoWith(entries: Record<string, Record<string, unknown>> = {}): Repository {
  const repo = initGlobalRepo()
  for (const [id, payload] of Object.entries(entries)) repo.register(id, payload)
  return repo
}

describe('resolvePlaneRef', () => {
  it('resolves a builtin plane feature ref', () => {
    const plane = resolvePlaneRef(repoWith(), '@builtin_plane_top', {}, 'mirror')
    expect(plane.origin).toEqual([0, 0, 0])
    expect(plane.normal).toEqual([0, 1, 0])
  })

  it('resolves the bare Front/Top/Right spellings', () => {
    expect(resolvePlaneRef(repoWith(), 'Top', {}, 'mirror').normal).toEqual([0, 1, 0])
    expect(resolvePlaneRef(repoWith(), 'Front', {}, 'mirror').normal).toEqual([0, 0, 1])
    expect(resolvePlaneRef(repoWith(), 'Right', {}, 'mirror').normal).toEqual([1, 0, 0])
  })

  it('resolves a datum plane feature record', () => {
    const repo = repoWith({
      pl1: { origin: [0, 5, 0], x_axis: [1, 0, 0], y_axis: [0, 0, -1], normal: [0, 1, 0] },
    })
    const plane = resolvePlaneRef(repo, '@pl1', {}, 'split')
    expect(plane.origin).toEqual([0, 5, 0])
    expect(plane.normal).toEqual([0, 1, 0])
  })

  it('normalizes a non-unit normal and keeps the direction', () => {
    const repo = repoWith({ f1: { type: 'flatface', origin: [1, 2, 3], normal: [0, 0, -4] } })
    const plane = resolvePlaneRef(repo, '@f1', {}, 'split')
    expect(plane.origin).toEqual([1, 2, 3])
    expect(plane.normal).toEqual([0, 0, -1])
  })

  it('names the leaf and the query when the plane is missing', () => {
    expect(() => resolvePlaneRef(repoWith(), '@nope', {}, 'split')).toThrow(
      'split: plane not found: "@nope"',
    )
  })

  it('refuses a record that is not plane-shaped', () => {
    const repo = repoWith({ p1: { type: 'point', origin: [0, 0, 0] } })
    expect(() => resolvePlaneRef(repo, '@p1', {}, 'mirror')).toThrow(
      'mirror: plane query did not resolve to a plane: "@p1"',
    )
  })

  it('refuses a zero normal by name', () => {
    const repo = repoWith({ f1: { type: 'flatface', origin: [0, 0, 0], normal: [0, 0, 0] } })
    expect(() => resolvePlaneRef(repo, '@f1', {}, 'split')).toThrow(
      'split: plane normal must be a non-zero vector',
    )
  })
})

describe('worldToSketch2d', () => {
  // The Right plane's frame (x->-Z, y->+Y) moved off the world origin, so a
  // sign or axis swap in either direction shows up.
  const plane = { origin: [3, -1, 2], x_axis: [0, 0, -1], y_axis: [0, 1, 0], normal: [1, 0, 0] }

  it('inverts sketchToWorld2d for an in-plane point', () => {
    const world = sketchToWorld2d([4, -7], plane)
    expect(world).toEqual([3, -8, -2])
    expect(worldToSketch2d(world, plane)).toEqual([4, -7])
  })

  it('drops the out-of-plane component', () => {
    expect(worldToSketch2d([10, -8, -2], plane)).toEqual([4, -7])
  })
})
