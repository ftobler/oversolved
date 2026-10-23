// @vitest-environment node
//
// The MCP document-handle operations without the kernel: resolving doc/docHash
// against the store, the run reply's default/returnDoc shape, and the one-line
// summary.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { DocHandleStore } from '../docHandleStore'
import { docHashOf } from '../docHash'
import { resolveDoc, runReply, summarizeDoc } from '../mcpDocRef'

function doc(label: string, body = 'body_ex1'): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [{ id: label, kind: 'sketch' }],
    part_style: { [body]: {} },
  } as PartDoc
}

describe('resolveDoc', () => {
  it('stores a passed-in document and returns its handle', () => {
    const documents = new DocHandleStore()
    const resolved = resolveDoc({ doc: doc('sk1') }, documents)
    expect(resolved).toMatchObject({ ok: true, docHash: docHashOf(doc('sk1')) })
    if (!resolved.ok) throw new Error('unreachable')
    expect(documents.get(resolved.docHash)).toEqual(doc('sk1'))
  })

  it('resolves a known handle', () => {
    const documents = new DocHandleStore()
    const hash = documents.put(doc('sk1'))
    expect(resolveDoc({ docHash: hash }, documents)).toMatchObject({
      ok: true,
      docHash: hash,
      doc: doc('sk1'),
    })
  })

  it('names the 32-document bound for an unknown handle', () => {
    const resolved = resolveDoc({ docHash: 'nope' }, new DocHandleStore())
    expect(resolved.ok).toBe(false)
    if (resolved.ok) throw new Error('unreachable')
    expect(resolved.error).toContain('32')
    expect(resolved.error).toContain('pass doc instead')
  })

  it('reports a malformed document as a tool error, not a throw', () => {
    const resolved = resolveDoc({ doc: { features: 'nope' } }, new DocHandleStore())
    expect(resolved.ok).toBe(false)
  })
})

describe('summarizeDoc', () => {
  it('names feature ids and kinds plus the part_style body ids', () => {
    expect(summarizeDoc(doc('sk1'))).toBe('features: sk1 (sketch); bodies: body_ex1')
  })

  it('lists only the live solve bodies, never the consumed ones part_style still carries', () => {
    // A boolean consumes its tool body, but reconcilePartStyle only adds new
    // ids, so part_style keeps a colour entry for the dead body.
    const consumed = {
      version: 1,
      kind: 'part',
      features: [
        { id: 'ex1', kind: 'extrude' },
        { id: 'ex2', kind: 'extrude' },
        { id: 'bo1', kind: 'boolean' },
      ],
      part_style: { body_ex1: {}, body_ex2: {} },
    } as unknown as PartDoc
    expect(summarizeDoc(consumed, ['body_ex1']))
      .toBe('features: ex1 (extrude), ex2 (extrude), bo1 (boolean); bodies: body_ex1')
  })

  it('says none when the solve left no bodies', () => {
    expect(summarizeDoc(doc('sk1'), [])).toBe('features: sk1 (sketch); bodies: none')
  })
})

describe('runReply', () => {
  const source = {
    ok: true,
    outcome: { steps: [{ index: 0, ok: true }] },
    doc: doc('sk1'),
    docHash: docHashOf(doc('sk1')),
    solve: { generation: 1, pending: false, running: false, lastError: null },
  }

  it('returns the handle, steps, solve and summary but not the doc by default', () => {
    const documents = new DocHandleStore()
    const reply = runReply(source, false, documents)
    expect(reply).toMatchObject({
      ok: true,
      docHash: source.docHash,
      steps: source.outcome.steps,
      summary: 'features: sk1 (sketch); bodies: body_ex1',
    })
    expect(reply.doc).toBeUndefined()
    expect(documents.get(source.docHash)).toEqual(source.doc)
  })

  it('includes the document with returnDoc true and stores the same content', () => {
    const documents = new DocHandleStore()
    const reply = runReply(source, true, documents)
    expect(reply.doc).toEqual(source.doc)
    expect(documents.get(reply.docHash as string)).toEqual(source.doc)
  })
})
