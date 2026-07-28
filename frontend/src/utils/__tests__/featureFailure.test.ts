/**
 * The failure decision used to live inline in the feature tree behind a list of
 * feature kinds, so a kind nobody remembered to add could fail silently. These
 * tests pin the two things that replaced it: the answer depends on the RESULT,
 * never on the kind, and `status !== 'ok'` is not the rule.
 */
import { describe, it, expect } from 'vitest'
import { featureFailure } from '@/utils/core/featureFailure'
import { STATUS_NAME } from '@/wasm-kernel/codec'

describe('featureFailure', () => {
  it('reports no failure for a healthy result', () => {
    expect(featureFailure('ex1', { ex1: { status: 'ok', body_id: 'body_ex1' } }, {}))
      .toEqual({ failed: false, message: '' })
  })

  it('reports no failure when the feature has no result at all', () => {
    expect(featureFailure('ex1', {}, {}).failed).toBe(false)
    expect(featureFailure('ex1', undefined, undefined).failed).toBe(false)
    expect(featureFailure('ex1', { ex1: null }, {}).failed).toBe(false)
  })

  it('reports the exception a thrown leaf was caught with', () => {
    // kernel/builder.ts writes exactly this for EVERY kind that throws.
    expect(featureFailure('db1', { db1: { status: 'exception', exception: 'body not found' } }, {}))
      .toEqual({ failed: true, message: 'body not found' })
  })

  it('does not care which kind the result came from', () => {
    // The kinds the old kind list left out: delete_body, import_step, mirror,
    // sketch, plane. The result shape is identical, so the answer must be too.
    for (const fid of ['db1', 'imp1', 'mir1', 'sk1', 'pl1']) {
      const r = featureFailure(fid, { [fid]: { status: 'exception', exception: 'boom' } }, {})
      expect(r, fid).toEqual({ failed: true, message: 'boom' })
    }
  })

  it('treats a sketch constraint status as a state, not a failure', () => {
    // A sketch NEVER returns 'ok' -- its status is its constraint level, so the
    // naive `status !== 'ok'` test reddened every sketch in the document.
    for (const status of STATUS_NAME) {
      expect(featureFailure('sk1', { sk1: { status } }, {}).failed, status).toBe(false)
    }
  })

  it('treats a suppressed feature as switched off, not failed', () => {
    // It used to render red AND struck through at the same time.
    expect(featureFailure('ex1', { ex1: { status: 'suppressed' } }, {}).failed).toBe(false)
  })

  it('counts an unrecognised status as a failure', () => {
    // 'error' is what extrude/revolve report for "no closed profile found".
    // A status word invented later must show up, not disappear.
    expect(featureFailure('ex1', { ex1: { status: 'error', exception: 'no closed profile found' } }, {}))
      .toEqual({ failed: true, message: 'no closed profile found' })
    expect(featureFailure('ex1', { ex1: { status: 'something_new' } }, {}).failed).toBe(true)
  })

  it('counts a partial result as a failure', () => {
    expect(featureFailure('fl1', { fl1: { status: 'partial', exception: '2 edges skipped' } }, {}))
      .toEqual({ failed: true, message: '2 edges skipped' })
  })

  it('fails when ANY body the feature made will not tessellate', () => {
    // A feature owns every body it made (kernel/features/bodySplit.ts), so
    // reading `body_id` alone left a split sibling rendering nothing behind a
    // healthy row.
    const result = { ex1: { status: 'ok', body_id: 'body_ex1', body_ids: ['body_ex1', 'body_ex1_1'] } }
    const bodies = { body_ex1: {}, body_ex1_1: { mesh_error: 'no shape' } }
    expect(featureFailure('ex1', result, bodies)).toEqual({ failed: true, message: 'no shape' })
  })

  it('prefers the exception message over a mesh error', () => {
    const result = { ex1: { status: 'exception', exception: 'sketch not found', body_id: 'body_ex1' } }
    expect(featureFailure('ex1', result, { body_ex1: { mesh_error: 'no shape' } }).message)
      .toBe('sketch not found')
  })

  it('still fails with an empty message when the result carried none', () => {
    expect(featureFailure('ex1', { ex1: { status: 'exception' } }, {}))
      .toEqual({ failed: true, message: '' })
  })
})
