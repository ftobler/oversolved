/**
 * The failure decision used to live inline in the feature tree behind a list of
 * feature kinds, so a kind nobody remembered to add could fail silently. These
 * tests pin the two things that replaced it: the answer depends on the RESULT,
 * never on the kind, and `status !== 'ok'` is not the rule.
 */
import { describe, it, expect } from 'vitest'
import { featureFailure } from '@/utils/core/featureFailure'
import { assemblyVerdict } from '@/utils/core/assemblyStatus'

describe('featureFailure', () => {
  it('reports no failure for a healthy result', () => {
    expect(featureFailure('ex1', { ex1: { status: 'ok', body_id: 'body_ex1' } }, {}))
      .toEqual({ failed: false, level: null, message: '' })
  })

  it('reports no failure when the feature has no result at all', () => {
    expect(featureFailure('ex1', {}, {}).failed).toBe(false)
    expect(featureFailure('ex1', undefined, undefined).failed).toBe(false)
    expect(featureFailure('ex1', { ex1: null }, {}).failed).toBe(false)
  })

  it('reports the exception a thrown leaf was caught with', () => {
    // kernel/builder.ts writes exactly this for EVERY kind that throws.
    expect(featureFailure('db1', { db1: { status: 'exception', exception: 'body not found' } }, {}))
      .toEqual({ failed: true, level: 'error', message: 'body not found' })
  })

  it('does not care which kind the result came from', () => {
    // The kinds the old kind list left out: delete_body, import_step, mirror,
    // sketch, plane. The result shape is identical, so the answer must be too.
    for (const fid of ['db1', 'imp1', 'mir1', 'sk1', 'pl1']) {
      const r = featureFailure(fid, { [fid]: { status: 'exception', exception: 'boom' } }, {})
      expect(r, fid).toEqual({ failed: true, level: 'error', message: 'boom' })
    }
  })

  it('treats a satisfiable sketch constraint status as a state, not a failure', () => {
    // A sketch NEVER returns 'ok' -- its status is its constraint level, so the
    // naive `status !== 'ok'` test reddened every sketch in the document.
    for (const status of ['fully_constrained', 'underconstrained']) {
      expect(featureFailure('sk1', { sk1: { status } }, {}).failed, status).toBe(false)
    }
  })

  it('marks an underconstrained sketch as a yellow warning with its DOF count', () => {
    // Free geometry is not good practice, so the row is yellow, but the sketch
    // still built: this is a warning, never the red of a failed feature and
    // never a failed export.
    const message = 'Underconstrained: 4 degrees of freedom. Free: l1, l2, l3, l4.'
    expect(featureFailure('sk1', { sk1: { status: 'underconstrained', solver_warning: message } }, {}))
      .toEqual({ failed: false, level: 'warning', message })
  })

  it('leaves a fully constrained sketch unmarked', () => {
    expect(featureFailure('sk1', { sk1: { status: 'fully_constrained', dof: 0 } }, {}))
      .toEqual({ failed: false, level: null, message: '' })
  })

  it('marks an overconstrained sketch as a hard error', () => {
    expect(featureFailure('sk1', { sk1: { status: 'overconstrained' } }, {}))
      .toEqual({ failed: true, level: 'error', message: 'the sketch is overconstrained' })
    // The culprit constraints the solve could not satisfy make the message
    // specific; a count is all a tree tooltip needs.
    expect(featureFailure('sk1', {
      sk1: {
        status: 'overconstrained',
        constraints: { c1: { culprit: true }, c2: { culprit: true }, c3: {} },
      },
    }, {}).message).toBe('the sketch is overconstrained (2 conflicting constraints)')
  })

  // A degenerate curve forces the same overconstrained verdict, but the bare
  // status word would hide the one thing the author can fix. The solver warning
  // names the entity, so it is the message.
  it('names a degenerate entity instead of the bare overconstrained verdict', () => {
    const warning = 'entity c1 is degenerate (circle radius 0 is not greater than TOL_TOPOLOGY_MERGE (0.00001), '
      + 'so the curve encloses no area); it is left out of profiles'
    expect(featureFailure('sk1', { sk1: { status: 'overconstrained', solver_warning: warning } }, {}))
      .toEqual({ failed: true, level: 'error', message: warning })
  })

  it('words an underconstrained sketch and assembly the same', () => {
    // The two editors read different solvers but must speak one language; a
    // user seeing the same count should not have to learn two sentences.
    const sketch = featureFailure('sk1', {
      sk1: { status: 'underconstrained', solver_warning: 'Underconstrained: 4 degrees of freedom. Free: l1, l2.' },
    }, {}).message
    const assembly = assemblyVerdict({
      verdict: 'underconstrained', dof: 4, mates: {}, parts: {},
    } as never).message
    expect(sketch.startsWith(assembly)).toBe(true)
    expect(assembly).toBe('Underconstrained: 4 degrees of freedom.')
  })

  it('treats a suppressed feature as switched off, not failed', () => {
    // It used to render red AND struck through at the same time.
    expect(featureFailure('ex1', { ex1: { status: 'suppressed' } }, {}).failed).toBe(false)
  })

  it('counts an unrecognised status as a failure', () => {
    // 'error' is what extrude/revolve report for "no closed profile found".
    // A status word invented later must show up, not disappear.
    expect(featureFailure('ex1', { ex1: { status: 'error', exception: 'no closed profile found' } }, {}))
      .toEqual({ failed: true, level: 'error', message: 'no closed profile found' })
    expect(featureFailure('ex1', { ex1: { status: 'something_new' } }, {}).failed).toBe(true)
  })

  it('marks a partial result as a warning, not a hard error', () => {
    // A partial fillet/chamfer built a valid solid from the picks that resolved:
    // downstream stays solvable, so it must render as a warning, not the red of
    // an exception. The message still says how many picks failed.
    expect(featureFailure('fl1', { fl1: { status: 'partial', exception: '2 edges skipped' } }, {}))
      .toEqual({ failed: true, level: 'warning', message: '2 edges skipped' })
  })

  it('promotes a partial result to a hard error when its own body will not tessellate', () => {
    // The warning level only applies to a partial result whose solid is valid.
    // A partial whose body fails to tessellate is as broken as any error.
    expect(featureFailure('fl1', { fl1: { status: 'partial', body_id: 'body_ex1' } }, { body_ex1: { mesh_error: 'no shape' } }))
      .toEqual({ failed: true, level: 'error', message: 'no shape' })
  })

  it('fails when ANY body the feature made will not tessellate', () => {
    // A feature owns every body it made (kernel/features/bodySplit.ts), so
    // reading `body_id` alone left a split sibling rendering nothing behind a
    // healthy row.
    const result = { ex1: { status: 'ok', body_id: 'body_ex1', body_ids: ['body_ex1', 'body_ex1_1'] } }
    const bodies = { body_ex1: {}, body_ex1_1: { mesh_error: 'no shape' } }
    expect(featureFailure('ex1', result, bodies)).toEqual({ failed: true, level: 'error', message: 'no shape' })
  })

  it('prefers the exception message over a mesh error', () => {
    const result = { ex1: { status: 'exception', exception: 'sketch not found', body_id: 'body_ex1' } }
    expect(featureFailure('ex1', result, { body_ex1: { mesh_error: 'no shape' } }).message)
      .toBe('sketch not found')
  })

  it('never shows a mark without words', () => {
    // The tree tooltip and the editor line both print the message; an empty
    // one left a red name that explained nothing.
    expect(featureFailure('ex1', { ex1: { status: 'exception' } }, {}))
      .toEqual({ failed: true, level: 'error', message: 'The feature failed to build.' })
    expect(featureFailure('fl1', { fl1: { status: 'partial' } }, {}))
      .toEqual({ failed: true, level: 'warning', message: 'Only part of the feature was applied.' })
  })

  it('marks a good solve that carries a solver warning as a warning', () => {
    // An up-to target that did not resolve fell back to a blind distance: the
    // body is valid, but not what was asked for, and this note is its only trace.
    expect(featureFailure('ex1', { ex1: { status: 'ok', body_id: 'body_ex1', solver_warning: 'used blind distance' } }, {}))
      .toEqual({ failed: true, level: 'warning', message: 'used blind distance' })
  })

  it('marks a shell whose sharp corners were replaced by an arc join', () => {
    // The 2026-11-12 report: the shell built, but with rounded corners the user
    // never asked for. It used to be a solver_note, which this file deliberately
    // ignores, so the tree stayed green while the geometry was substituted.
    const warning = 'shell: the sharp join was refused (build_not_done); corners were rounded. ' +
      'Set Corners to Round to accept this, or change the geometry'
    expect(featureFailure('sh1', { sh1: { status: 'ok', body_id: 'body_ex1', solver_warning: warning } }, {}))
      .toEqual({ failed: true, level: 'warning', message: warning })
  })

  it('does not mark a solver note: it describes geometry the solve did build', () => {
    // The tangent chain a blend ran along is informational, so the tree row and
    // the open editor stay unmarked.
    expect(featureFailure('fi1', {
      fi1: { status: 'ok', body_id: 'body_ex1', solver_note: 'fillet: 8 edges were filleted (7 not picked)' },
    }, {}))
      .toEqual({ failed: false, level: null, message: '' })
  })

  it('joins a partial result exception with its solver warning', () => {
    expect(featureFailure('h1', { h1: { status: 'partial', exception: '1/4 sites missed', solver_warning: 'body deleted' } }, {}))
      .toEqual({ failed: true, level: 'warning', message: '1/4 sites missed; body deleted' })
  })

  it('keeps an error an error when a solver warning rides along', () => {
    // The hard failure is the message; the warning cannot soften it.
    expect(featureFailure('ex1', { ex1: { status: 'exception', exception: 'boom', solver_warning: 'note' } }, {}))
      .toEqual({ failed: true, level: 'error', message: 'boom' })
  })

  it('falls back to the mesh warning when an error result has no exception', () => {
    expect(featureFailure('ex1', { ex1: { status: 'error', mesh_warning: 'body has no shape' } }, {}).message)
      .toBe('body has no shape')
  })
})
