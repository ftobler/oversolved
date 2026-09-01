import { describe, it, expect } from 'vitest'
import {
  IdPipeline, SKETCH_VERTEX_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, ORIGIN_LAYER_NAME,
} from '../IdPipeline'
import { collectEntitiesFromPixels } from '../collectEntitiesFromPixels'
import { idToRGB } from '../idEncoding'
import { IdImage } from './pickCanvasHarness'

/**
 * A mark that lost its pixel is still pickable.
 *
 * Driven through the real layers rather than a hand-built buffer, because the
 * position index is populated by `registerBody` and a synthetic `allocate` does
 * not have it -- which is exactly why the erasure characterisations could pass
 * for so long. Here the entities are registered the way the app registers them,
 * and only then is one of their pixels painted.
 */

const SIZE = 120
const MID = 60
const CURSOR = { x: MID + 0.5, y: MID + 0.5 }

function scene() {
  const image = new IdImage(SIZE, SIZE)
  const p = new IdPipeline({ width: SIZE, height: SIZE })
  p.target.markClean()
  return { image, p, renderer: image.renderer() }
}

const idOf = (p: IdPipeline, layer: string, q: string) => p.registry.lookupKey(layer, q)!

describe('coincident marks: the loser of the pixel is still an answer', () => {
  it('returns both sketch vertices whichever of them won the draw', () => {
    // Two endpoints at one place -- a line end dropped on a circle centre before
    // any coincident constraint exists, which `suppressedCoincidentVertexIds`
    // deliberately does not merge. One pixel gets written, and until now the
    // other entity was simply gone.
    for (const painted of ['vertex:S1:L1:end', 'vertex:S1:C1:center']) {
      const { image, p, renderer } = scene()
      p.sketchVertexLayer.registerBody({
        bodyKey: 'S1',
        vertices: [[3, 4, 0], [3, 4, 0]],
        vertexQueries: ['vertex:S1:L1:end', 'vertex:S1:C1:center'],
      })
      image.mark(MID, MID, idOf(p, SKETCH_VERTEX_LAYER_NAME, painted))
      expect(p.resolveAllSync(renderer, CURSOR).map(h => h.entityKey))
        .toEqual(['vertex:S1:L1:end', 'vertex:S1:C1:center'])
      p.dispose()
    }
  })

  it('leads with the first registered, not with whoever drew last', () => {
    // The old answer was "whichever draw came last", which for the sketch layer
    // meant the appended inferred contacts always beat the real vertices they
    // sat on. Registration order is the sketch's own entity order, so this is
    // stable across re-registrations of an unchanged sketch.
    const { image, p, renderer } = scene()
    p.sketchVertexLayer.registerBody({
      bodyKey: 'S1',
      vertices: [[1, 1, 0], [1, 1, 0]],
      vertexQueries: ['vertex:S1:L1:end', 'dock:S1:C1:L1'],
    })
    image.mark(MID, MID, idOf(p, SKETCH_VERTEX_LAYER_NAME, 'dock:S1:C1:L1'))
    expect(p.resolveSync(renderer, CURSOR)!.entityKey).toBe('vertex:S1:L1:end')
    p.dispose()
  })

  it('gives each recovered mark its own id and pick key, not the winner\'s', () => {
    // They are separate entities that happen to coincide, so highlight
    // isolation has to keep working per member.
    const { image, p, renderer } = scene()
    p.sketchVertexLayer.registerBody({
      bodyKey: 'S1',
      vertices: [[0, 2, 0], [0, 2, 0]],
      vertexQueries: ['vertex:S1:A:start', 'vertex:S1:B:end'],
    })
    image.mark(MID, MID, idOf(p, SKETCH_VERTEX_LAYER_NAME, 'vertex:S1:A:start'))
    const all = p.resolveAllSync(renderer, CURSOR)
    expect(new Set(all.map(h => h.id)).size).toBe(2)
    expect(all.map(h => h.pickKey)).toEqual(['vertex:S1:A:start', 'vertex:S1:B:end'])
    // Both stand the same distance from the cursor, because they are the same point.
    expect(all[0].distancePx).toBe(all[1].distancePx)
    p.dispose()
  })

  it('recovers across layers and ranks the recovered mark on its own priority', () => {
    // The guaranteed case: a circle centre constrained to the document origin.
    // The origin marker owns the pixel here, and the sketch vertex is recovered
    // from underneath it -- then ranked ahead of it, because a recovered mark is
    // sorted on its OWN priority and the point outranks the datum it sits on.
    const { image, p, renderer } = scene()
    p.sketchVertexLayer.registerBody({
      bodyKey: 'S1', vertices: [[0, 0, 0]], vertexQueries: ['vertex:S1:C1:center'],
    })
    p.originLayer.registerBody({
      bodyKey: '@builtin_origin', vertices: [[0, 0, 0]], vertexQueries: ['@builtin_origin'],
    })
    image.mark(MID, MID, idOf(p, ORIGIN_LAYER_NAME, '@builtin_origin'))
    const all = p.resolveAllSync(renderer, CURSOR)
    expect(all.map(h => h.entityKey)).toEqual(['vertex:S1:C1:center', '@builtin_origin'])
    expect(all.map(h => h.layer)).toEqual([SKETCH_VERTEX_LAYER_NAME, ORIGIN_LAYER_NAME])
    p.dispose()
  })

  it('still ranks a nearer unrelated mark below a higher layer, as before', () => {
    // The expansion must not disturb the ordering rule: priority first, then
    // distance. A recovered mark is sorted on its own priority, not on the
    // priority of whatever outdrew it.
    const { image, p, renderer } = scene()
    p.sketchVertexLayer.registerBody({
      bodyKey: 'S1', vertices: [[0, 0, 0]], vertexQueries: ['vertex:S1:C1:center'],
    })
    p.originLayer.registerBody({
      bodyKey: '@builtin_origin', vertices: [[0, 0, 0]], vertexQueries: ['@builtin_origin'],
    })
    const curve = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'entity:S1:C1')
    image.line(MID - 30, MID, MID + 30, MID, curve)
    image.mark(MID + 5, MID, idOf(p, ORIGIN_LAYER_NAME, '@builtin_origin'))
    expect(p.resolveAllSync(renderer, CURSOR).map(h => h.entityKey))
      .toEqual(['vertex:S1:C1:center', '@builtin_origin', 'entity:S1:C1'])
    p.dispose()
  })

  it('drops a recovered mark the tool is not allowed to pick', () => {
    const { image, p, renderer } = scene()
    p.sketchVertexLayer.registerBody({
      bodyKey: 'S1', vertices: [[0, 0, 0]], vertexQueries: ['vertex:S1:C1:center'],
    })
    p.originLayer.registerBody({
      bodyKey: '@builtin_origin', vertices: [[0, 0, 0]], vertexQueries: ['@builtin_origin'],
    })
    image.mark(MID, MID, idOf(p, ORIGIN_LAYER_NAME, '@builtin_origin'))
    expect(p.resolveAllSync(renderer, CURSOR, {
      allowedLayers: new Set([ORIGIN_LAYER_NAME]),
    }).map(h => h.entityKey)).toEqual(['@builtin_origin'])
    p.dispose()
  })

  it('stops recovering once the body is unregistered', () => {
    const { image, p, renderer } = scene()
    const body = {
      bodyKey: 'S1',
      vertices: [[3, 4, 0], [3, 4, 0]] as [number, number, number][],
      vertexQueries: ['vertex:S1:L1:end', 'vertex:S1:C1:center'],
    }
    p.sketchVertexLayer.registerBody(body)
    const winner = idOf(p, SKETCH_VERTEX_LAYER_NAME, 'vertex:S1:L1:end')
    image.mark(MID, MID, winner)
    expect(p.resolveAllSync(renderer, CURSOR)).toHaveLength(2)
    p.sketchVertexLayer.unregisterBody('S1')
    expect(p.registry.coincidentMarkIds(winner)).toEqual([])
    p.dispose()
  })

  it('collects both from a band sweep, so the two selection routes agree', () => {
    // The box never sees the covered mark by scanning -- it owns no pixel
    // anywhere -- but it is inside the box just the same.
    const { p } = scene()
    p.sketchVertexLayer.registerBody({
      bodyKey: 'S1',
      vertices: [[3, 4, 0], [3, 4, 0]],
      vertexQueries: ['vertex:S1:L1:end', 'vertex:S1:C1:center'],
    })
    const buf = new Uint8Array(2 * 2 * 4)
    const [r, g, b] = idToRGB(idOf(p, SKETCH_VERTEX_LAYER_NAME, 'vertex:S1:L1:end'))
    buf[0] = r; buf[1] = g; buf[2] = b; buf[3] = 255
    expect(collectEntitiesFromPixels(buf, 2, 2, p.registry).map(e => e.entityKey))
      .toEqual(['vertex:S1:L1:end', 'vertex:S1:C1:center'])
    p.dispose()
  })
})
