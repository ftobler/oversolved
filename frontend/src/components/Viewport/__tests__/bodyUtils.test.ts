import { describe, it, expect } from 'vitest'
import { getBodiesToRender, getGhostBodiesToRender, computeEffectiveVisibleBodies } from '@/components/Viewport/bodyUtils'
import type { Feature, BodyResult, PartStyleEntry } from '@/types/cad'

describe('getBodiesToRender', () => {
  const features: Feature[] = [
    { id: 'sk1', kind: 'sketch' },
    { id: 'ex1', kind: 'extrude' },
  ]

  const bodies: Record<string, BodyResult> = {
    body_ex1: {
      id: 'body_ex1',
      created_by: 'ex1',
      modified_by: [],
      mesh: {
        vertices: [],
        faces: [],
        face_data: [],
        face_queries: [],
      },
    } as unknown as BodyResult,
  }

  it('renders all bodies when visibleBodies is undefined', () => {
    const items = getBodiesToRender(bodies, features, undefined, undefined)
    expect(items).toHaveLength(1)
    expect(items[0].featureId).toBe('ex1')
  })

  it('marks bodies not in visibleBodies set as invisible', () => {
    const visible = new Set<string>()
    const items = getBodiesToRender(bodies, features, undefined, visible)
    expect(items).toHaveLength(1)
    expect(items[0].visible).toBe(false)
  })

  it('marks bodies in visibleBodies set as visible', () => {
    const visible = new Set(['body_ex1'])
    const items = getBodiesToRender(bodies, features, undefined, visible)
    expect(items).toHaveLength(1)
    expect(items[0].visible).toBe(true)
  })

  it('filters by rollbackPosition', () => {
    const items = getBodiesToRender(bodies, features, 1, new Set(['body_ex1']))
    expect(items).toHaveLength(0)
  })

  it('returns one item per visible body', () => {
    const items = getBodiesToRender(bodies, features, undefined, undefined)
    expect(items).toHaveLength(1)
  })

  it('keeps rendering when created_by does not match any feature', () => {
    const orphanBodies: Record<string, BodyResult> = {
      body_orphan: {
        id: 'body_orphan',
        created_by: 'missing_feature',
        modified_by: [],
        mesh: { vertices: [], faces: [], face_data: [], face_queries: [] },
      } as unknown as BodyResult,
    }
    const items = getBodiesToRender(orphanBodies, features, undefined, undefined)
    expect(items).toHaveLength(1)
    expect(items[0].featureId).toBe('missing_feature')
  })

  it('falls back featureId to bodyId when created_by is missing', () => {
    const noCreatorBodies: Record<string, BodyResult> = {
      body_no_creator: {
        id: 'body_no_creator',
        modified_by: [],
        mesh: { vertices: [], faces: [], face_data: [], face_queries: [] },
      } as unknown as BodyResult,
    }
    const items = getBodiesToRender(noCreatorBodies, features, undefined, undefined)
    expect(items).toHaveLength(1)
    expect(items[0].featureId).toBe('body_no_creator')
  })

  it('handles assembly bodies with mesh data (no edges/vertices)', () => {
    const assemblyBodies: Record<string, BodyResult> = {
      'body_handle1_0': {
        id: 'body_handle1_0',
        created_by: 'handle1',
        modified_by: [],
        mesh: { vertices: new Float32Array(9), indices: new Uint32Array(3), triangle_to_face: new Uint32Array(1) },
      } as unknown as BodyResult,
      'body_handle2_0': {
        id: 'body_handle2_0',
        created_by: 'handle2',
        modified_by: [],
        mesh: { vertices: new Float32Array(9), indices: new Uint32Array(3), triangle_to_face: new Uint32Array(1) },
      } as unknown as BodyResult,
    }
    const items = getBodiesToRender(assemblyBodies, undefined, undefined, undefined)
    expect(items).toHaveLength(2)
    expect(items[0].featureId).toBe('handle1')
    expect(items[0].edges).toEqual([])
    expect(items[0].vertices).toBeUndefined()
    expect(items[1].featureId).toBe('handle2')
  })

  it('handles assembly bodies with visibleBodies filter', () => {
    const assemblyBodies: Record<string, BodyResult> = {
      'body_a_0': {
        id: 'body_a_0',
        created_by: 'a',
        modified_by: [],
        mesh: { vertices: new Float32Array(9), indices: new Uint32Array(3) },
      } as unknown as BodyResult,
      'body_b_0': {
        id: 'body_b_0',
        created_by: 'b',
        modified_by: [],
        mesh: { vertices: new Float32Array(9), indices: new Uint32Array(3) },
      } as unknown as BodyResult,
    }
    const visible = new Set(['body_a_0'])
    const items = getBodiesToRender(assemblyBodies, undefined, undefined, visible)
    expect(items).toHaveLength(2)
    expect(items[0].visible).toBe(true)
    expect(items[1].visible).toBe(false)
  })
})

describe('getGhostBodiesToRender', () => {
  const features: Feature[] = [
    { id: 'ex1', kind: 'extrude' },
    { id: 'ex2', kind: 'extrude' },
    { id: 'db1', kind: 'delete_body' },
  ]
  const ghostBody = (id: string, createdBy: string): BodyResult =>
    ({ id, created_by: createdBy, modified_by: [], mesh: { vertices: [], faces: [], face_data: [], face_queries: [] } } as unknown as BodyResult)

  const pickBodies: Record<string, BodyResult> = {
    body_ex1: ghostBody('body_ex1', 'ex1'),
    body_ex2: ghostBody('body_ex2', 'ex2'),
  }
  const hidden = (...ids: string[]): Record<string, PartStyleEntry> =>
    Object.fromEntries(ids.map(id => [id, { visible: false } as PartStyleEntry]))

  it('marks the ghost of a body the edited feature deleted, without hiding it', () => {
    // Still visible: hiding it dropped the body out of the id buffer, so the
    // add_delete_body_ref toggle could never be fired a second time.
    const preview = { body_ex1: pickBodies.body_ex1 }
    const items = getGhostBodiesToRender(pickBodies, preview, features, {})
    expect(items.map(i => [i.bodyId, i.visible, !!i.doomed]))
      .toEqual([['body_ex1', true, false], ['body_ex2', true, true]])
  })

  it('marks every ghost when the edited feature deletes all bodies', () => {
    // Regression: the preview holds no body at all, so nothing derived from it
    // can name what left -- the removal has to be its own flag.
    const items = getGhostBodiesToRender(pickBodies, {}, features, {})
    expect(items.map(i => [i.visible, !!i.doomed])).toEqual([[true, true], [true, true]])
  })

  it('keeps ghosts of bodies the edit leaves alone unmarked', () => {
    const items = getGhostBodiesToRender(pickBodies, pickBodies, features, {})
    expect(items.map(i => i.visible)).toEqual([true, true])
    expect(items.some(i => i.doomed)).toBe(false)
  })

  it('keeps a user-hidden body hidden even though the edit keeps it', () => {
    const items = getGhostBodiesToRender(pickBodies, pickBodies, features, hidden('body_ex2'))
    expect(items.map(i => i.visible)).toEqual([true, false])
  })

  it('does not resurrect a user-hidden body that the edit also removes', () => {
    // visible and doomed are orthogonal: the mark says what the edit
    // does, the visibility says what the user asked for, and the user wins.
    const preview = { body_ex1: pickBodies.body_ex1 }
    const items = getGhostBodiesToRender(pickBodies, preview, features, hidden('body_ex1', 'body_ex2'))
    expect(items.map(i => [i.bodyId, i.visible, !!i.doomed]))
      .toEqual([['body_ex1', false, false], ['body_ex2', false, true]])
  })

  it('reads visibility from partStyle, not from a set derived from the preview', () => {
    // The regression this guards: visibleBodies is computed over the PREVIEW
    // bodies, so a removed body is missing from it for the same reason a
    // user-hidden body is. Feeding the ghost layer that set made every removal
    // invisible again, which is the bug this feature exists to fix.
    const preview = { body_ex1: pickBodies.body_ex1 }
    const derived = computeEffectiveVisibleBodies(preview, new Set(), {})
    expect(derived?.has('body_ex2')).toBe(false)  // the trap
    const items = getGhostBodiesToRender(pickBodies, preview, features, {})
    expect(items.find(i => i.bodyId === 'body_ex2')?.visible).toBe(true)
  })

  it('ignores rollbackPosition so every prior body stays pickable', () => {
    const items = getGhostBodiesToRender(pickBodies, pickBodies, features, undefined)
    expect(items).toHaveLength(2)
  })
})

describe('computeEffectiveVisibleBodies', () => {
  const twoBodyResult = (id: string, createdBy: string): BodyResult =>
    ({ id, created_by: createdBy, modified_by: [], mesh: { vertices: [], faces: [] } } as unknown as BodyResult)

  const bodies: Record<string, BodyResult> = {
    body_a: twoBodyResult('body_a', 'feat_a'),
    body_b: twoBodyResult('body_b', 'feat_b'),
  }
  const allVisible = new Set(['feat_a', 'feat_b'])

  const partStyle = (overrides: Record<string, Partial<PartStyleEntry>>): Record<string, PartStyleEntry> => {
    const out: Record<string, PartStyleEntry> = {}
    for (const [id, override] of Object.entries(overrides)) {
      out[id] = { ...override }
    }
    return out
  }

  it('returns undefined when no bodies (nothing to filter)', () => {
    expect(computeEffectiveVisibleBodies(undefined, allVisible, {})).toBeUndefined()
  })

  it('includes all bodies when features are visible and no overrides', () => {
    const result = computeEffectiveVisibleBodies(bodies, allVisible, {})
    expect(result?.has('body_a')).toBe(true)
    expect(result?.has('body_b')).toBe(true)
  })

  it('excludes one body when it is explicitly hidden', () => {
    const result = computeEffectiveVisibleBodies(bodies, allVisible, partStyle({ body_a: { visible: false } }))
    expect(result?.has('body_a')).toBe(false)
    expect(result?.has('body_b')).toBe(true)
  })

  it('returns empty set (not undefined) when all bodies are explicitly hidden', () => {
    const result = computeEffectiveVisibleBodies(bodies, allVisible, partStyle({ body_a: { visible: false }, body_b: { visible: false } }))
    expect(result).toBeInstanceOf(Set)
    expect(result?.size).toBe(0)
  })

  it('keeps body visibility independent from feature visibility', () => {
    const result = computeEffectiveVisibleBodies(bodies, new Set(), partStyle({ body_a: { visible: true } }))
    expect(result?.has('body_a')).toBe(true)
    expect(result?.has('body_b')).toBe(true)
  })

  it('hides only one body when multiple bodies share one creator feature', () => {
    const arrayBodies: Record<string, BodyResult> = {
      body_UAM7nPd8Trb1gGJ7Wefu6uUc: twoBodyResult('body_UAM7nPd8Trb1gGJ7Wefu6uUc', 'UAM7nPd8Trb1gGJ7Wefu6uUc'),
      body_UAM7nPd8Trb1gGJ7Wefu6uUc_1: twoBodyResult('body_UAM7nPd8Trb1gGJ7Wefu6uUc_1', 'UAM7nPd8Trb1gGJ7Wefu6uUc'),
      body_UAM7nPd8Trb1gGJ7Wefu6uUc_2: twoBodyResult('body_UAM7nPd8Trb1gGJ7Wefu6uUc_2', 'UAM7nPd8Trb1gGJ7Wefu6uUc'),
      body_UAM7nPd8Trb1gGJ7Wefu6uUc_3: twoBodyResult('body_UAM7nPd8Trb1gGJ7Wefu6uUc_3', 'UAM7nPd8Trb1gGJ7Wefu6uUc'),
    }

    const result = computeEffectiveVisibleBodies(
      arrayBodies,
      new Set(['UAM7nPd8Trb1gGJ7Wefu6uUc']),
      partStyle({ body_UAM7nPd8Trb1gGJ7Wefu6uUc_1: { visible: false } }),
    )

    expect(result?.has('body_UAM7nPd8Trb1gGJ7Wefu6uUc')).toBe(true)
    expect(result?.has('body_UAM7nPd8Trb1gGJ7Wefu6uUc_1')).toBe(false)
    expect(result?.has('body_UAM7nPd8Trb1gGJ7Wefu6uUc_2')).toBe(true)
    expect(result?.has('body_UAM7nPd8Trb1gGJ7Wefu6uUc_3')).toBe(true)
  })

  it('treats missing visible as visible', () => {
    const result = computeEffectiveVisibleBodies(bodies, allVisible, partStyle({ body_a: { name: 'test' } }))
    expect(result?.has('body_a')).toBe(true)
  })
})
