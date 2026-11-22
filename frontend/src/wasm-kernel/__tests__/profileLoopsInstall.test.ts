// @vitest-environment node
//
// Regression: the node sketch package's loaders install the profile-loop
// facade. `setSketchSolver(bytes)` carries solve bytes only and topology has
// its own injector, so before this a host that booted the package directly
// (`measureReal`, the postRegister fixture sweep, the robustness fuzz chain)
// hit "profile loops: Rust core not initialised" on every area build.

import { describe, it, expect } from 'vitest'
import { loadSolver, loadSolverFresh } from '../loadSolver'
import { loopSignedArea, profileLoopsAvailable, setProfileLoopsBytes } from '../profileLoops'
import type { LoopEdge } from '../profileLoopsCodec'

const square: LoopEdge[] = [
  { kind: 'line', start: [0, 0], end: [3, 0] },
  { kind: 'line', start: [3, 0], end: [3, 2] },
  { kind: 'line', start: [3, 2], end: [0, 2] },
  { kind: 'line', start: [0, 2], end: [0, 0] },
]

const solve = loadSolver()

describe.skipIf(!solve)('the node sketch package installs the profile-loop facade', () => {
  it('loadSolver installs it with the cached module', () => {
    setProfileLoopsBytes(null)
    expect(profileLoopsAvailable()).toBe(false)
    expect(loadSolver()).not.toBeNull()
    expect(profileLoopsAvailable()).toBe(true)
    expect(loopSignedArea(square, 1)).toBe(6)
  })

  it('loadSolverFresh installs it from the fresh module instance', () => {
    setProfileLoopsBytes(null)
    const bundle = loadSolverFresh()
    if (bundle === null) return
    expect(profileLoopsAvailable()).toBe(true)
    expect(loopSignedArea(square, 1)).toBe(6)
  })
})
