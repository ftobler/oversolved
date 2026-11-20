// A foreign-vertex projection source is accepted by the key set a constraint
// may name on that kind, and the solved registry must publish the same set as
// slash points: a source is either refused at apply or resolves at solve, never
// "accepted, then unresolvable". This pins the two tables to each other.
import { describe, it, expect } from 'vitest'
import { initGlobalRepo } from '../query'
import { postRegister } from '../features/postRegister'
import {
  ENTITIES,
  entityPointKeys,
  entityPointXY,
  fitSplineVertices,
} from '@/registry/entityRegistry'

type Handles = 'start' | 'end' | 'both'

// One solved block per kind, chosen so every key is a distinct point.
const SOLVED: Record<string, { params: number[]; handles?: Handles }> = {
  line: { params: [0, 0, 10, 5] },
  circle: { params: [1, 2, 3] },
  arc: { params: [-15, 20, 17, 90, 270] },
  ellipse: { params: [4.5, 40, 20, 8, 30] },
  spline: { params: [0, 0, 10, 20, 20, 20, 30, 0] },
  fit_spline: { params: [0, 0, 5, 4, 10, 0, 0, -2, 10, 2], handles: 'both' },
  point: { params: [7, 8] },
}

function registerOne(kind: string): ReturnType<typeof initGlobalRepo> {
  const block = SOLVED[kind]
  const repo = initGlobalRepo()
  postRegister(repo, 'sk1', {
    id: 'sk1',
    entities: [{ id: 'e1', kind, ...(block.handles ? { handles: block.handles } : {}) }],
  }, { status: 'ok', geometry: { e1: block.params } })
  return repo
}

/** Every entity kind with a solved block. `project` is a tool registration, not
 *  a kind the solver emits. A missing fixture throws instead of skipping the
 *  kind, so the parity guard cannot silently stop pinning a new kind. */
function solvedKinds(): Array<{ kind: string; block: (typeof SOLVED)[string] }> {
  return ENTITIES.flatMap(def => {
    if (def.kind === 'project') return []
    const block = SOLVED[def.kind]
    if (block === undefined) throw new Error(`no solved fixture for entity kind '${def.kind}'`)
    return [{ kind: def.kind, block }]
  })
}

function slashKeys(repo: ReturnType<typeof initGlobalRepo>): string[] {
  return [...repo.elements.keys()]
    .filter(key => key.startsWith('sk1/e1/'))
    .map(key => key.slice('sk1/e1/'.length))
}

function registeredXy(repo: ReturnType<typeof initGlobalRepo>, key: string): number[] | undefined {
  const payload = repo.elements.get('sk1/e1/' + key) as { external_xy?: number[] } | undefined
  return payload?.external_xy
}

describe('a projected vertex key resolves wherever a constraint may name it', () => {
  it('registers exactly the point keys of every kind', () => {
    for (const { kind, block } of solvedKinds()) {
      const expected = entityPointKeys(kind, block.params.length, block.handles)
      expect(expected, kind).toBeDefined()
      expect(new Set(slashKeys(registerOne(kind))), kind).toEqual(new Set(expected))
    }
  })

  it('registers each key at the point entityPointXY names', () => {
    for (const { kind, block } of solvedKinds()) {
      const repo = registerOne(kind)
      for (const key of entityPointKeys(kind, block.params.length, block.handles)!) {
        const xy = entityPointXY(kind, block.params, key, block.handles)
        expect(xy, `${kind}/${key}`).toBeDefined()
        const published = registeredXy(repo, key)
        expect(published, `${kind}/${key}`).toBeDefined()
        expect(published![0], `${kind}/${key} x`).toBeCloseTo(xy![0], 9)
        expect(published![1], `${kind}/${key} y`).toBeCloseTo(xy![1], 9)
      }
    }
  })

  it('registers nothing for a key the kind does not have', () => {
    const repo = registerOne('arc')
    expect(slashKeys(repo)).not.toContain('major1')
    expect(entityPointXY('arc', SOLVED.arc.params, 'major1')).toBeUndefined()
    expect(entityPointXY('line', SOLVED.line.params, 'center')).toBeUndefined()
    expect(entityPointXY('unknown', [1, 2], 'start')).toBeUndefined()
  })

  it('registers a fit spline handle only when the block carries it', () => {
    const bare = fitSplineVertices(3)
    const withHandle = fitSplineVertices(3, 'start')
    expect(bare.vertices.map(vertex => vertex.key)).toEqual(['start', 'fit1', 'end'])
    expect(withHandle.vertices.map(vertex => vertex.key)).toEqual(['start', 'fit1', 'end', 'c1'])
    const repo = initGlobalRepo()
    postRegister(repo, 'sk1', {
      id: 'sk1', entities: [{ id: 'e1', kind: 'fit_spline', handles: 'start' }],
    }, { status: 'ok', geometry: { e1: [0, 0, 5, 4, 10, 0, 0, -2] } })
    expect(new Set(slashKeys(repo))).toEqual(new Set(['start', 'fit1', 'end', 'c1']))
  })
})

describe('entityPointXY mirrors the solver point selectors', () => {
  it('derives an arc end from its angle in degrees', () => {
    const params = [-15, 20, 17, 90, 270]
    expect(entityPointXY('arc', params, 'center')).toEqual([-15, 20])
    const start = entityPointXY('arc', params, 'start')!
    expect(start[0]).toBeCloseTo(-15, 9)
    expect(start[1]).toBeCloseTo(37, 9)
    const end = entityPointXY('arc', params, 'end')!
    expect(end[0]).toBeCloseTo(-15, 9)
    expect(end[1]).toBeCloseTo(3, 9)
  })

  it('derives the four ellipse axis ends, off-axis included', () => {
    const axis = (theta: number) => {
      const params = [4.5, 40, 20, 8, theta]
      return {
        center: entityPointXY('ellipse', params, 'center'),
        major1: entityPointXY('ellipse', params, 'major1'),
        major2: entityPointXY('ellipse', params, 'major2'),
        minor1: entityPointXY('ellipse', params, 'minor1'),
        minor2: entityPointXY('ellipse', params, 'minor2'),
      }
    }
    expect(axis(0)).toEqual({
      center: [4.5, 40],
      major1: [24.5, 40],
      major2: [-15.5, 40],
      minor1: [4.5, 48],
      minor2: [4.5, 32],
    })
    // Rust `point()`: minor1 = c + b*(-sin t, cos t), minor2 = c + b*(sin t, -cos t).
    const rotated = axis(30)
    expect(rotated.major1![0]).toBeCloseTo(4.5 + 20 * Math.cos(Math.PI / 6), 9)
    expect(rotated.major1![1]).toBeCloseTo(50, 9)
    expect(rotated.minor1![0]).toBeCloseTo(0.5, 9)
    expect(rotated.minor1![1]).toBeCloseTo(40 + 8 * Math.cos(Math.PI / 6), 9)
    expect(rotated.minor2![0]).toBeCloseTo(8.5, 9)
    expect(rotated.minor2![1]).toBeCloseTo(40 - 8 * Math.cos(Math.PI / 6), 9)
  })

  it('reads a spline control point and a fit spline interior point from their slots', () => {
    const spline = [0, 0, 10, 20, 20, 20, 30, 0]
    expect(entityPointXY('spline', spline, 'start')).toEqual([0, 0])
    expect(entityPointXY('spline', spline, 'c1')).toEqual([10, 20])
    expect(entityPointXY('spline', spline, 'c2')).toEqual([20, 20])
    expect(entityPointXY('spline', spline, 'end')).toEqual([30, 0])
    const fit = SOLVED.fit_spline.params
    expect(entityPointXY('fit_spline', fit, 'fit1', 'both')).toEqual([5, 4])
    expect(entityPointXY('fit_spline', fit, 'c1', 'both')).toEqual([0, -2])
  })
})
