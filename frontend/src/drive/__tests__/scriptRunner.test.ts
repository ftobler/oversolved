// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { runScript, type ScriptStep } from '../scriptRunner'
import { okResult, errorResult } from '@/session/result'

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
})
