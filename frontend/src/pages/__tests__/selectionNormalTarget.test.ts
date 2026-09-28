import { describe, it, expect, vi } from 'vitest'
import { resolveSelectionNormalTarget } from '@/pages/selectionNormalTarget'
import type { FaceFrame } from '@/pages/buildContextMenu'
import type { PartFeature } from '@/types/cad'

// Part.tsx turns the normal selection into the one thing "Normal to" can aim at
// before it builds the context menu, so buildContextMenu never touches the
// store or the body registry. The face lookup is injected: here a fake stands
// in for the registry-backed findFaceFrame.

const features = [
  { id: 'Front', kind: 'plane' },
  { id: 'plane1', kind: 'plane' },
  { id: 'sketch1', kind: 'sketch' },
] as PartFeature[]
const builtInIds = new Set(['Front'])

const FLAT: FaceFrame = { normal: [0, 0, 1], center: [1, 2, 3] }

function faceFrames(frames: Record<string, FaceFrame>) {
  return vi.fn((query: string, _pickKey: string | undefined) => frames[query] ?? null)
}

function resolve(
  ids: string[],
  lookup = faceFrames({ faceQ: FLAT }),
  picks: Map<string, Set<string>> = new Map(),
) {
  return resolveSelectionNormalTarget(new Set(ids), picks, features, builtInIds, lookup)
}

describe('resolveSelectionNormalTarget', () => {
  it('resolves a selected user plane to its feature id', () => {
    expect(resolve(['@plane1'])).toEqual({ kind: 'plane', featureId: 'plane1' })
  })

  it('resolves a selected built-in plane by its builtin query', () => {
    expect(resolve(['@builtin_plane_front'])).toEqual({ kind: 'plane', featureId: 'Front' })
  })

  it('resolves a selected planar face to its frame', () => {
    expect(resolve(['faceQ'])).toEqual({ kind: 'face', query: 'faceQ', normal: [0, 0, 1], center: [1, 2, 3] })
  })

  it('hands the lookup the single pickKey the click recorded', () => {
    const lookup = faceFrames({ faceQ: FLAT })
    resolve(['faceQ'], lookup, new Map([['faceQ', new Set(['b1#face#4'])]]))
    expect(lookup).toHaveBeenCalledWith('faceQ', 'b1#face#4')
  })

  it('falls back to the query when the pick claims are ambiguous or gone', () => {
    const lookup = faceFrames({ faceQ: FLAT })
    resolve(['faceQ'], lookup, new Map([['faceQ', new Set(['b1#face#1', 'b1#face#2'])]]))
    expect(lookup).toHaveBeenCalledWith('faceQ', undefined)
  })

  it('offers nothing for an empty selection', () => {
    expect(resolve([])).toBeNull()
  })

  it('offers nothing for two selected faces or a face plus a plane', () => {
    const lookup = faceFrames({ faceQ: FLAT, faceR: FLAT })
    expect(resolve(['faceQ', 'faceR'], lookup)).toBeNull()
    expect(resolve(['faceQ', '@plane1'], lookup)).toBeNull()
  })

  it('offers nothing for a selected edge, curved face or sketch entity', () => {
    // The lookup answers null for anything that is not a registered planar face.
    expect(resolve(['edgeQ'])).toBeNull()
    expect(resolve(['curvedQ'])).toBeNull()
    expect(resolve(['entity:e1'])).toBeNull()
  })

  it('offers nothing for a selected sketch feature, which is no plane', () => {
    expect(resolve(['@sketch1'], faceFrames({}))).toBeNull()
  })
})
