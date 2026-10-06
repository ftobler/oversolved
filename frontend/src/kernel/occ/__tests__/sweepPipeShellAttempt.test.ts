// Unit coverage for attemptPipeShellSweep, the per-mode retry loop
// sweepProfileWithLineage uses to build a pipe-shell solid. Pure loop logic
// (no face/profile building), so it is driven with a minimal fake
// oc.BRepOffsetAPI_MakePipeShell -- no opencascade.js needed.
//
// Regression this guards: lastError used to survive across loop iterations
// unreset, so a mode that threw followed by a LATER mode that failed
// silently (no exception, just IsDone()/MakeSolid() false) would report the
// earlier mode's stale exception instead of a plain "no solid" outcome. The
// fix resets lastError at the top of every attempt.
import { describe, it, expect } from 'vitest'
import { attemptPipeShellSweep } from '../prismLineage'
import { DisposeScope } from '../disposeScope'
import type { OccModule, OccShape, OccEnumValue, OccListOfShape } from '../occTypes'

const MODE_A = { value: 1 } as unknown as OccEnumValue
const MODE_B = { value: 2 } as unknown as OccEnumValue

type Outcome = 'throw' | 'silent-fail' | 'success'

/** A fake BRepOffsetAPI_MakePipeShell builder whose Build()/IsDone()/MakeSolid()
 *  behavior is scripted per instance via `outcome`. */
function fakeBuilder(outcome: Outcome) {
  return {
    SetTransitionMode: (): void => {},
    Add_1: (): void => {},
    Build: (): void => {
      if (outcome === 'throw') throw new Error(`boom from ${outcome}`)
    },
    IsDone: (): boolean => outcome !== 'silent-fail' ? true : false,
    MakeSolid: (): boolean => outcome === 'success',
    Shape: (): OccShape => ({ marker: 'solid' }) as unknown as OccShape,
    Generated: (): OccListOfShape => ({}) as unknown as OccListOfShape,
    delete: (): void => {},
  }
}

/** Fake oc module whose BRepOffsetAPI_MakePipeShell hands out builders from
 *  `outcomes`, in call order (one per mode attempted). */
function fakeOcc(outcomes: Outcome[]): OccModule {
  let i = 0
  return {
    BRepOffsetAPI_MakePipeShell: function () {
      const b = fakeBuilder(outcomes[i])
      i++
      return b
    },
  } as unknown as OccModule
}

const spineWire = { marker: 'spine' } as unknown as OccShape
const outerWire = { marker: 'outer' } as unknown as OccShape

describe('attemptPipeShellSweep', () => {
  it('returns the first successful mode and no error', () => {
    const oc = fakeOcc(['success', 'success'])
    const scope = new DisposeScope()
    const { result, lastError } = attemptPipeShellSweep(oc, scope, spineWire, outerWire, [MODE_A, MODE_B])
    expect(lastError).toBeNull()
    expect(result).not.toBeNull()
    expect(result?.solid).toEqual({ marker: 'solid' })
  })

  it('falls through a throwing mode to a later successful mode, with no leftover error', () => {
    const oc = fakeOcc(['throw', 'success'])
    const scope = new DisposeScope()
    const { result, lastError } = attemptPipeShellSweep(oc, scope, spineWire, outerWire, [MODE_A, MODE_B])
    expect(lastError).toBeNull()
    expect(result).not.toBeNull()
  })

  it('reports the last exception when every mode throws', () => {
    const oc = fakeOcc(['throw', 'throw'])
    const scope = new DisposeScope()
    const { result, lastError } = attemptPipeShellSweep(oc, scope, spineWire, outerWire, [MODE_A, MODE_B])
    expect(result).toBeNull()
    expect(lastError).toBeInstanceOf(Error)
    expect((lastError as Error).message).toBe('boom from throw')
  })

  it('does not leak an earlier mode exception when the LAST mode fails silently', () => {
    // Mode A throws; mode B fails without throwing (IsDone/MakeSolid false).
    // A stale lastError from mode A must not survive to the final result.
    const oc = fakeOcc(['throw', 'silent-fail'])
    const scope = new DisposeScope()
    const { result, lastError } = attemptPipeShellSweep(oc, scope, spineWire, outerWire, [MODE_A, MODE_B])
    expect(result).toBeNull()
    expect(lastError).toBeNull()
  })
})
