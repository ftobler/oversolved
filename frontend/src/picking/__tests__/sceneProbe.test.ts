// @vitest-environment node

import { describe, it, expect } from 'vitest'
import {
  hitTest, buildSceneProbe, type SceneProbe, type SceneProbePickable,
} from '../sceneProbe'
import { PICK_LADDER, pickPriorityOf } from '../layerNames'

/**
 * The probe's ordering contract: layer priority descending first, pixel
 * distance ascending second, mark index then publication order for ties. This
 * mirrors `IdResolver.resolvePixelWindowAll`'s (priority, distance, scan,
 * mark order) ranking with the probe's mark index standing in for the pixel
 * scan. The headline test below pins the whole ladder as a literal: a rung
 * moved or a sort key dropped must fail here.
 */

function pointPickable(layer: string, id: string, x: number, y: number): SceneProbePickable {
  return { pickKey: id, entityKey: id, layer, kind: 'point', screenPoints: [[x, y]] }
}

function polylinePickable(layer: string, id: string, points: [number, number][]): SceneProbePickable {
  return { pickKey: id, entityKey: id, layer, kind: 'polyline', screenPoints: points }
}

function polygonPickable(layer: string, id: string, points: [number, number][]): SceneProbePickable {
  return { pickKey: id, entityKey: id, layer, kind: 'polygon', screenPoints: points }
}

function probeOf(pickables: SceneProbePickable[]): SceneProbe {
  return {
    revision: 1,
    camera: null,
    canvas: { width: 800, height: 600 },
    sketchPlane: null,
    pickables,
  }
}

const CURSOR: [number, number] = [100, 100]

describe('scene probe hitTest ordering', () => {
  it('orders every ladder layer by priority at one shared pixel (headline pin)', () => {
    // The literal expected order is the ladder read top-down. Adding, removing
    // or reordering a rung fails here even though the pipeline follows the data.
    const pickables = PICK_LADDER.map((rung, i) =>
      pointPickable(rung.name, `p${i}`, CURSOR[0], CURSOR[1]))
    const hits = hitTest(probeOf(pickables), CURSOR[0], CURSOR[1])
    expect(hits.map(h => h.layer)).toEqual([
      'gizmoHandle',
      'featureHandle',
      'dimensionLabel',
      'sketchVertex',
      'originMarker',
      'sketchEntity',
      'sketchSurface',
      'vertex',
      'edge',
      'face',
      'planeFace',
    ])
    expect(hits.map(h => h.distancePx)).toEqual(new Array(PICK_LADDER.length).fill(0))
  })

  it('lets priority beat distance: a point at the rim still outranks a nearer lower rung', () => {
    const probe = probeOf([
      pointPickable('sketchSurface', 'surface', CURSOR[0], CURSOR[1]),
      pointPickable('planeFace', 'plane', CURSOR[0] + 1, CURSOR[1]),
      pointPickable('sketchVertex', 'vertex', CURSOR[0] + 7.9, CURSOR[1]),
    ])
    expect(hitTest(probe, CURSOR[0], CURSOR[1]).map(h => h.pickKey))
      .toEqual(['vertex', 'surface', 'plane'])
  })

  it('candidate distance is the true cursor distance, not whole-pixel rounding', () => {
    const probe = probeOf([pointPickable('sketchVertex', 'v', CURSOR[0] + 3, CURSOR[1] + 4)])
    const hits = hitTest(probe, CURSOR[0] + 0.5, CURSOR[1])
    expect(hits[0].distancePx).toBeCloseTo(Math.hypot(2.5, 4), 10)
  })

  it('includes a mark exactly on the shared radius and drops one past it', () => {
    const radius = 8  // (DEFAULT_WINDOW_SIZE - 1) / 2
    const onRim = probeOf([pointPickable('sketchVertex', 'rim', CURSOR[0] + radius, CURSOR[1])])
    const pastRim = probeOf([pointPickable('sketchVertex', 'past', CURSOR[0] + radius + 0.01, CURSOR[1])])
    expect(hitTest(onRim, CURSOR[0], CURSOR[1]).map(h => h.pickKey)).toEqual(['rim'])
    expect(hitTest(pastRim, CURSOR[0], CURSOR[1])).toEqual([])
  })

  it('honours a custom window size through the shared radius', () => {
    const probe = probeOf([pointPickable('sketchVertex', 'v', CURSOR[0] + 5, CURSOR[1])])
    expect(hitTest(probe, CURSOR[0], CURSOR[1], { windowSize: 5 })).toEqual([])
    expect(hitTest(probe, CURSOR[0], CURSOR[1], { windowSize: 17 })).toHaveLength(1)
  })

  it('ranks a nearer mark above a farther one within a layer (the distance key)', () => {
    // The far mark is published FIRST, so publication order alone would put it
    // ahead: only the distance-ascending key can return 'near' first. Flipping
    // the key to descending, or dropping it, fails here.
    const probe = probeOf([
      pointPickable('sketchVertex', 'far', CURSOR[0] + 6, CURSOR[1]),
      pointPickable('sketchVertex', 'near', CURSOR[0] + 2, CURSOR[1]),
    ])
    const hits = hitTest(probe, CURSOR[0], CURSOR[1])
    expect(hits.map(h => h.pickKey)).toEqual(['near', 'far'])
    expect(hits.map(h => h.distancePx)).toEqual([2, 6])
  })

  it('breaks a same-layer distance tie by publication order', () => {
    const probe = probeOf([
      pointPickable('sketchVertex', 'first', CURSOR[0] + 2, CURSOR[1]),
      pointPickable('sketchVertex', 'second', CURSOR[0] - 2, CURSOR[1]),
    ])
    expect(hitTest(probe, CURSOR[0], CURSOR[1]).map(h => h.pickKey)).toEqual(['first', 'second'])
  })

  it('keeps co-located marks in publication order instead of collapsing them', () => {
    // The resolver recovers every registry mark at one pixel; the probe must
    // list them all too, or a co-located sketch point or origin would vanish.
    const probe = probeOf([
      pointPickable('originMarker', 'origin', CURSOR[0], CURSOR[1]),
      pointPickable('sketchVertex', 'v1', CURSOR[0], CURSOR[1]),
      pointPickable('sketchVertex', 'v2', CURSOR[0], CURSOR[1]),
    ])
    expect(hitTest(probe, CURSOR[0], CURSOR[1]).map(h => h.pickKey)).toEqual(['v1', 'v2', 'origin'])
  })

  it('breaks a distance tie by mark index: an earlier mark wins', () => {
    // Both pickables touch the cursor (distance 0). `later-mark` only does so
    // on its second segment; `first-mark` on its first, so the earlier mark
    // index ranks first, like the resolver's scan index prefers the
    // earlier-scanned pixel.
    const probe = probeOf([
      polylinePickable('sketchEntity', 'later-mark', [[0, 0], [95, 100], [105, 100]]),
      polylinePickable('sketchEntity', 'first-mark', [[CURSOR[0], CURSOR[1]], [50, 50]]),
    ])
    const hits = hitTest(probe, CURSOR[0], CURSOR[1])
    expect(hits.map(h => h.pickKey)).toEqual(['first-mark', 'later-mark'])
    expect(hits.map(h => h.markIndex)).toEqual([0, 1])
    expect(hits.map(h => h.distancePx)).toEqual([0, 0])
  })

  it('measures a polyline by its nearest segment and reports that segment', () => {
    const probe = probeOf([
      polylinePickable('sketchEntity', 'line', [[CURSOR[0] - 50, CURSOR[1] - 3], [CURSOR[0] + 50, CURSOR[1] - 3]]),
    ])
    const hits = hitTest(probe, CURSOR[0], CURSOR[1])
    expect(hits[0].distancePx).toBeCloseTo(3, 10)
    expect(hits[0].markIndex).toBe(0)
  })

  it('treats a polygon as an area: inside is distance 0, outside is edge distance', () => {
    const square: [number, number][] = [[90, 90], [110, 90], [110, 110], [90, 110]]
    const inside = probeOf([polygonPickable('sketchSurface', 'srf', square)])
    expect(hitTest(inside, 100, 100)[0].distancePx).toBe(0)
    // Just outside the left edge: within the 8 px reach, distance to the edge.
    const near = hitTest(inside, 86, 100)
    expect(near[0].distancePx).toBeCloseTo(4, 10)
    expect(hitTest(inside, 80, 100)).toEqual([])
  })

  it('lets a filtered-out winner drop to the next rung', () => {
    const probe = probeOf([
      pointPickable('sketchVertex', 'pt', CURSOR[0], CURSOR[1]),
      pointPickable('sketchEntity', 'curve', CURSOR[0] + 1, CURSOR[1]),
    ])
    const hits = hitTest(probe, CURSOR[0], CURSOR[1], {
      allowedLayers: new Set(['sketchEntity']),
    })
    expect(hits.map(h => h.pickKey)).toEqual(['curve'])
    expect(pickPriorityOf('sketchEntity')).toBeLessThan(pickPriorityOf('sketchVertex'))
  })
})

describe('scene probe build', () => {
  it('projects each source pickable through the probe camera', () => {
    const camera = {
      position: [0, 0, 0] as [number, number, number],
      orientation: [0, 0, 0, 1] as [number, number, number, number],
      zoom: 1,
      // Maps world x in [-400, 400] and y in [-300, 300] onto the 800x600 canvas.
      projectionMatrix: [
        1 / 400, 0, 0, 0,
        0, 1 / 300, 0, 0,
        0, 0, -1 / 500, 0,
        0, 0, 0, 1,
      ],
    }
    const built = buildSceneProbe({
      revision: 7,
      camera,
      canvas: { width: 800, height: 600 },
      sketchPlane: null,
      pickables: [{
        pickKey: 'p', entityKey: 'e', layer: 'sketchVertex', kind: 'point',
        points: [[0, 0, 0], [400, 300, 0]],
      }],
    })
    expect(built.revision).toBe(7)
    expect(built.pickables[0].screenPoints).toEqual([[400, 300], [800, 0]])
    expect(hitTest(built, 400, 300).map(h => h.pickKey)).toEqual(['p'])
  })

  it('publishes no screen marks when no camera has been published yet', () => {
    const built = buildSceneProbe({
      revision: 1,
      camera: null,
      canvas: { width: 800, height: 600 },
      sketchPlane: null,
      pickables: [{
        pickKey: 'p', entityKey: 'e', layer: 'sketchVertex', kind: 'point', points: [[0, 0, 0]],
      }],
    })
    expect(built.pickables[0].screenPoints).toEqual([])
    expect(hitTest(built, 400, 300)).toEqual([])
  })
})
