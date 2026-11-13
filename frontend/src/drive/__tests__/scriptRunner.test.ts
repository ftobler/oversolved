// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { runScript, type AnyScriptStep, type ScriptStep } from '../scriptRunner'
import { okResult, errorResult, noOpResult } from '@/session/result'

const step = (command: string, continueOnError = false): ScriptStep => ({ command, continueOnError })
const mutationStep = (continueOnError = false): ScriptStep =>
  ({ mutation: { type: 'set_rollback', position: null }, continueOnError })

const commandOf = (s: ScriptStep): string => ('command' in s ? s.command : s.mutation.type)

describe('runScript', () => {
  it('runs steps in order and records every Result', async () => {
    const seen: string[] = []
    const outcome = await runScript([step('a'), step('b')], (s) => {
      seen.push(commandOf(s))
      return okResult(['id-' + commandOf(s)])
    })
    expect(seen).toEqual(['a', 'b'])
    expect(outcome.ok).toBe(true)
    expect(outcome.steps.map(o => o.id)).toEqual(['a', 'b'])
    expect(outcome.steps[0].createdIds).toEqual(['id-a'])
  })

  it('stops on the first error by default and reports it', async () => {
    const seen: string[] = []
    const outcome = await runScript([step('a'), step('b'), step('c')], (s) => {
      const id = commandOf(s)
      seen.push(id)
      return id === 'b' ? errorResult('no-document', 'boom') : okResult()
    })
    expect(seen).toEqual(['a', 'b'])
    expect(outcome.ok).toBe(false)
    expect(outcome.steps).toHaveLength(2)
    expect(outcome.steps[1].error).toEqual({ code: 'no-document', message: 'boom' })
  })

  it('continues past a failed step when the step asks for it', async () => {
    const seen: string[] = []
    const outcome = await runScript([step('a'), step('b', true), step('c')], (s) => {
      const id = commandOf(s)
      seen.push(id)
      return id === 'b' ? errorResult('no-document', 'boom') : okResult()
    })
    expect(seen).toEqual(['a', 'b', 'c'])
    expect(outcome.ok).toBe(false)
    expect(outcome.steps.map(o => o.ok)).toEqual([true, false, true])
  })

  it('records a thrown executor failure instead of letting it escape', async () => {
    const outcome = await runScript([step('a')], () => { throw new Error('kaboom') })
    expect(outcome.ok).toBe(false)
    expect(outcome.steps[0].error).toEqual({ code: 'thrown', message: 'kaboom' })
  })

  it('treats the adapter null as a no-document failure and supports mutation steps', async () => {
    const kinds: string[] = []
    const outcome = await runScript([mutationStep(), step('undo')], (s) => {
      kinds.push('mutation' in s ? 'mutation' : 'command')
      return 'mutation' in s ? null : okResult()
    })
    expect(kinds).toEqual(['mutation'])
    expect(outcome.ok).toBe(false)
    expect(outcome.steps[0].kind).toBe('mutation')
    expect(outcome.steps[0].id).toBe('set_rollback')
  })

  it('settles after every executed step, including the failing one', async () => {
    let settled = 0
    await runScript(
      [step('a'), step('b'), step('c')],
      (s) => (commandOf(s) === 'b' ? errorResult('no-document', 'nope') : okResult()),
      () => { settled++ },
    )
    expect(settled).toBe(2)
  })

  it('awaits an async runner and stops at its first failure', async () => {
    const seen: string[] = []
    const outcome = await runScript([step('a'), step('b'), step('c')], async (s) => {
      const id = commandOf(s)
      seen.push(id)
      return id === 'b' ? errorResult('no-document', 'boom') : okResult()
    })
    expect(seen).toEqual(['a', 'b'])
    expect(outcome.ok).toBe(false)
    expect(outcome.steps[1].error).toEqual({ code: 'no-document', message: 'boom' })
  })

  it('records a rejected promise as a thrown outcome', async () => {
    const outcome = await runScript([step('a'), step('b')], async (s) => {
      if (commandOf(s) === 'a') throw new Error('async kaboom')
      return okResult()
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.steps).toHaveLength(1)
    expect(outcome.steps[0].error).toEqual({ code: 'thrown', message: 'async kaboom' })
  })

  it('reports a null result as a no-document failure, never as ok', async () => {
    const outcome = await runScript([step('a')], () => null)
    expect(outcome.ok).toBe(false)
    expect(outcome.steps[0].error).toMatchObject({ code: 'no-document' })
  })

  it('reports a creating mutation the session classified as a no-op as a refusal', async () => {
    const outcome = await runScript(
      [{
        mutation: {
          type: 'add_projected_entity', featureId: 'sk1', kind: 'point',
          source: '@builtin_origin', entityId: 'o',
        },
      }],
      () => noOpResult(),
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.steps[0].ok).toBe(false)
    expect(outcome.steps[0].error).toEqual({
      code: 'no-change',
      message: 'add_projected_entity changed nothing: the applier refused it',
    })
  })

  it('keeps a legitimate non-creating no-op as a success', async () => {
    // Setting a field to the value it already has changes nothing on purpose;
    // only a creator that added nothing was refused by its applier.
    const outcome = await runScript([mutationStep()], () => noOpResult())
    expect(outcome.ok).toBe(true)
    expect(outcome.steps[0].ok).toBe(true)
    expect(outcome.steps[0].createdIds).toEqual([])
  })

  it('turns more than 200 created ids into a count', async () => {
    const pattern: ScriptStep = {
      mutation: { type: 'pattern_entities', featureId: 'sk1', sourceIds: ['l1'], mode: 'linear', count: 3, pitch: 5 },
    }
    const ids = (count: number) => Array.from({ length: count }, (_, i) => `e${i}`)

    const atLimit = await runScript([pattern], () => okResult(ids(200)))
    expect(atLimit.steps[0].createdIds).toHaveLength(200)
    expect(atLimit.steps[0].createdCount).toBeUndefined()

    const pastLimit = await runScript([pattern], () => okResult(ids(201)))
    expect(pastLimit.steps[0].createdIds).toEqual([])
    expect(pastLimit.steps[0].createdCount).toBe(201)
  })

  it('keeps the documented per-copy ids on an assembly pattern step', async () => {
    // add_part_pattern's reply is per copy, not bulk: the sketch-copy limit
    // must not swallow a large hole pattern's instance ids.
    const assemble = {
      mutation: { type: 'add_part_pattern', featureId: 'pat1', source_body: 'b1', mode: 'linear', count: 3 },
    } as AnyScriptStep
    const ids = Array.from({ length: 240 }, (_, i) => `copy-${i}`)
    const outcome = await runScript([assemble], () => okResult(ids))
    expect(outcome.steps[0].createdIds).toHaveLength(240)
    expect(outcome.steps[0].createdCount).toBeUndefined()
  })
})
