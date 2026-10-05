// Shared fixtures for the split builder test files. Not a test file itself, so
// vitest does not collect it.

import { Repository } from './query'
import { type BuildDeps, type FeatureResult } from './builder'
import type { FeatureCheckpoint } from './types3d'

export function makeDeps(overrides?: Partial<BuildDeps>): BuildDeps {
  return {
    trySolveFeature: (_feature, _repo, _bodyStore, _featuresById): FeatureResult => ({ status: 'ok' }),
    postRegister: () => {},
    initGlobalRepo: () => new Repository(),
    tessellateBodies: () => ({}),
    ...overrides,
  }
}

export function checkpoint(spec: Record<string, unknown>): FeatureCheckpoint {
  return {
    spec,
    result: {},
    repo_snapshot: { elements: {}, ancestral: {}, byUuid: {} },
    body_store_snapshot: {},
    bodies_snapshot: {},
  }
}

export const makeTrackerDeps = () => makeDeps({
  trySolveFeature: (feature): FeatureResult => ({ status: 'ok', solved: feature.id }),
})
