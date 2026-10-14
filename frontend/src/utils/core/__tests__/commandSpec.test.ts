import { describe, it, expect, vi } from 'vitest'
import {
  CommandRegistry,
  Field,
  noParams,
  objectParams,
  valueParam,
  type CommandSpec,
} from '@/utils/core/commandSpec'
import { okResult } from '@/session/result'

// The registry is the boundary programmatic callers (scripts, keymaps, the
// future drive surface) reach commands through, so its own failure modes get
// the same coverage as a spec body's happy path: unknown ids and payloads that
// miss the params schema must be observable Results, never throws or silent
// no-ops.

interface FixtureContext {
  editor: 'part'
  log: string[]
}

const fixture = (): FixtureContext => ({ editor: 'part', log: [] })

function fixtureSpec<P = null>(
  spec: Partial<CommandSpec<FixtureContext, P>> = {},
): CommandSpec<FixtureContext, P> {
  return {
    id: 'undo',
    label: 'Undo',
    params: noParams() as unknown as CommandSpec<FixtureContext, P>['params'],
    enabled: () => true,
    run: () => okResult(),
    undoable: false,
    ...spec,
  }
}

describe('params schemas', () => {
  it('noParams accepts undefined and any legacy payload', () => {
    expect(noParams().parse(undefined)).toEqual({ ok: true, value: null })
    expect(noParams().parse({ legacy: true })).toEqual({ ok: true, value: null })
  })

  it('valueParam parses the raw payload itself', () => {
    const spec = valueParam(Field.string())
    expect(spec.parse('handle-1')).toEqual({ ok: true, value: 'handle-1' })
    expect(spec.parse(7)).toEqual({ ok: false, error: 'expected a string' })
  })

  it('objectParams accepts a well-formed payload and names the failing field', () => {
    const spec = objectParams({ handle: Field.string(), fixed: Field.boolean(), before: Field.nullableString() })
    expect(spec.parse({ handle: 'h', fixed: true, before: null })).toEqual({
      ok: true,
      value: { handle: 'h', fixed: true, before: null },
    })
    expect(spec.parse({ handle: 'h', fixed: 'yes', before: null })).toEqual({
      ok: false,
      error: 'field "fixed": expected a boolean',
    })
    expect(spec.parse({ handle: 'h', before: null })).toEqual({
      ok: false,
      error: 'field "fixed": expected a boolean',
    })
    expect(spec.parse(null)).toEqual({ ok: false, error: 'expected an object payload' })
    expect(spec.parse(['h'])).toEqual({ ok: false, error: 'expected an object payload' })
  })

  it('objectParams parses nested object fields', () => {
    const spec = objectParams({ handle: Field.string(), pos: Field.object({ tx: Field.number(), ty: Field.number(), tz: Field.number() }) })
    expect(spec.parse({ handle: 'h', pos: { tx: 1, ty: 2, tz: 3 } })).toEqual({
      ok: true,
      value: { handle: 'h', pos: { tx: 1, ty: 2, tz: 3 } },
    })
    expect(spec.parse({ handle: 'h', pos: { tx: 1, ty: 'x', tz: 3 } })).toEqual({
      ok: false,
      error: 'field "pos": field "ty": expected a finite number',
    })
  })

  it('number rejects non-finite values', () => {
    const spec = valueParam(Field.number())
    expect(spec.parse(2.5)).toEqual({ ok: true, value: 2.5 })
    expect(spec.parse(Number.NaN)).toEqual({ ok: false, error: 'expected a finite number' })
    expect(spec.parse(Infinity)).toEqual({ ok: false, error: 'expected a finite number' })
  })

  it('any passes the payload through for operation-validated shapes', () => {
    const patch = { flip: true }
    expect(valueParam(Field.any()).parse(patch)).toEqual({ ok: true, value: patch })
  })
})

describe('CommandRegistry', () => {
  it('runs a registered spec against the live context and returns its Result', () => {
    const ctx = fixture()
    const registry = new CommandRegistry(() => ctx)
    const created = ['f1']
    registry.register(fixtureSpec({ run: (c) => { c.log.push('ran'); return okResult(created) } }))

    expect(registry.execute('undo')).toEqual({ ok: true, createdIds: created })
    expect(ctx.log).toEqual(['ran'])
  })

  it('returns an unknown-command failure for an id with no spec', () => {
    const registry = new CommandRegistry(fixture)
    expect(registry.execute('redo')).toEqual({
      ok: false,
      code: 'unknown-command',
      message: 'unknown command "redo"',
    })
  })

  it('rejects a payload that does not match the params schema without running the body', () => {
    const registry = new CommandRegistry(fixture)
    const run = vi.fn(() => okResult())
    registry.register(fixtureSpec({
      id: 'delete_part',
      params: valueParam(Field.string()),
      run,
    }))

    const result = registry.execute('delete_part', 42)
    expect(result).toEqual({
      ok: false,
      code: 'invalid-params',
      message: 'invalid params for "delete_part": expected a string',
    })
    expect(run).not.toHaveBeenCalled()
    expect(registry.execute('delete_part', 'handle-1')).toEqual({ ok: true, createdIds: [] })
  })

  it('enabled returns the spec verdict for the live context and a reason for an unknown id', () => {
    const registry = new CommandRegistry(fixture)
    registry.register(fixtureSpec({
      id: 'undo',
      enabled: ctx => ctx.log.length === 0 ? 'nothing to undo' : true,
    }))
    expect(registry.enabled('undo')).toBe('nothing to undo')
    expect(registry.enabled('redo')).toBe('unknown command "redo"')
  })

  it('reports the registered ids in insertion order', () => {
    const registry = new CommandRegistry(fixture)
    registry.register(fixtureSpec({ id: 'undo' }))
    registry.register(fixtureSpec({ id: 'redo' }))
    expect(registry.ids()).toEqual(['undo', 'redo'])
    expect(registry.has('undo')).toBe(true)
    expect(registry.has('cancel_draw')).toBe(false)
  })

  it('an older unregister leaves a newer spec for the same id in place', () => {
    const registry = new CommandRegistry(fixture)
    const older = vi.fn(() => okResult())
    const newer = vi.fn(() => okResult())
    const unregisterOlder = registry.register(fixtureSpec({ run: older }))
    registry.register(fixtureSpec({ run: newer }))

    unregisterOlder()
    registry.execute('undo')
    expect(older).not.toHaveBeenCalled()
    expect(newer).toHaveBeenCalledOnce()
  })

  it('clear removes every spec', () => {
    const registry = new CommandRegistry(fixture)
    registry.register(fixtureSpec({ id: 'undo' }))
    registry.clear()
    expect(registry.ids()).toEqual([])
  })
})
