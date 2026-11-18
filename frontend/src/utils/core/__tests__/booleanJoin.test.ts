// The under-picked boolean message: what the user must still pick, in the
// words of the editor, per operation. The stored target/tools split stays
// internal, so none of these may quote a stored key.

import { describe, it, expect } from 'vitest'
import { booleanPickProblem } from '@/utils/core/booleanJoin'

describe('booleanPickProblem', () => {
  it('union with no picks asks for two parts to join', () => {
    expect(booleanPickProblem('union', '', [])).toBe('boolean: pick at least two parts to join')
  })

  it('union with the base only asks for one more part', () => {
    expect(booleanPickProblem('union', '@body_a', [])).toBe('boolean: pick at least one more part to join')
  })

  it('subtract without a target names the part to subtract from', () => {
    expect(booleanPickProblem('subtract', '', ['@body_b']))
      .toBe('boolean: pick the target part to subtract from')
  })

  it('subtract without a tool asks for at least one tool part', () => {
    expect(booleanPickProblem('subtract', '@body_a', []))
      .toBe('boolean: pick at least one tool part to subtract')
  })

  it('intersect without a target names the part to intersect', () => {
    expect(booleanPickProblem('intersect', '', ['@body_b']))
      .toBe('boolean: pick the target part to intersect')
  })

  it('intersect without a tool asks for at least one tool part', () => {
    expect(booleanPickProblem('intersect', '@body_a', []))
      .toBe('boolean: pick at least one tool part to intersect with')
  })

  it('counts a union pick list through the editor list, so a base repeated in tools is one pick', () => {
    // A legacy hand-written doc can list the base among the tools; the join
    // list folds that duplicate away, so the list still has one entry. A lone
    // tool entry with no target is likewise the list's first pick.
    expect(booleanPickProblem('union', '@body_a', ['@body_a']))
      .toBe('boolean: pick at least one more part to join')
    expect(booleanPickProblem('union', '', ['@body_a']))
      .toBe('boolean: pick at least one more part to join')
  })

  it('treats an absent operation as the stored default, union', () => {
    expect(booleanPickProblem(undefined, '', [])).toBe('boolean: pick at least two parts to join')
    expect(booleanPickProblem(undefined, '@body_a', [])).toBe('boolean: pick at least one more part to join')
  })

  it('returns null once the picks are complete for every operation', () => {
    expect(booleanPickProblem('union', '@body_a', ['@body_b'])).toBeNull()
    expect(booleanPickProblem('subtract', '@body_a', ['@body_b'])).toBeNull()
    expect(booleanPickProblem('intersect', '@body_a', ['@body_b'])).toBeNull()
  })
})
