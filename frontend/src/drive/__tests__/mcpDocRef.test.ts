// @vitest-environment node
//
// The MCP document-handle operations without the kernel: resolving doc/docHash
// against the store, the run reply's default/returnDoc shape, and the one-line
// summary.

import { describe, it, expect } from 'vitest'
import type { AssemblyDoc, PartDoc } from '@/types/cad'
import { DocHandleStore, DOC_HANDLE_CAPACITY, assemblyHandleOf } from '../docHandleStore'
import { docHashOf } from '../docHash'
import { requirePartDoc, resolveDoc, runReply, selectReply, summarizeDoc } from '../mcpDocRef'
import { CURRENT_DOC_VERSION } from '@/persistence/docSchema'
import type { SelectResult } from '@/kernel/select'

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
    // The handle names the payload as sent; the stored copy is the loaded one,
    // stamped current so its next reload does not migrate it again.
    expect(documents.get(resolved.docHash)).toEqual({ ...doc('sk1'), version: CURRENT_DOC_VERSION })
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

  it('names the document bound for an unknown handle', () => {
    const resolved = resolveDoc({ docHash: 'nope' }, new DocHandleStore())
    expect(resolved.ok).toBe(false)
    if (resolved.ok) throw new Error('unreachable')
    expect(resolved.error).toContain(String(DOC_HANDLE_CAPACITY))
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
    // A document can carry a colour entry for a consumed body (an older doc, or
    // the browser's add-only reconcile), so the solve's live set wins.
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

  it('names every split sibling a disjoint pattern leaves behind', () => {
    const patterned = {
      version: 1,
      kind: 'part',
      features: [{ id: 'ca1', kind: 'pattern', pattern: { subject: 'body', mode: 'circular' } }],
      part_style: { body_ca1: {} },
    } as unknown as PartDoc
    expect(summarizeDoc(patterned, ['body_ca1', 'body_ca1_1', 'body_ca1_2', 'body_ca1_3']))
      .toBe('features: ca1 (pattern); bodies: body_ca1, body_ca1_1, body_ca1_2, body_ca1_3')
  })
})

describe('runReply', () => {
  const source = {
    ok: true,
    solved: true,
    outcome: { steps: [{ index: 0, ok: true }] },
    doc: doc('sk1'),
    docHash: docHashOf(doc('sk1')),
    solve: { generation: 1, pending: false, running: false, lastError: null },
    features: [],
  }

  it('returns the handle, steps, solve, solved and summary but not the doc by default', () => {
    const documents = new DocHandleStore()
    const reply = runReply(source, false, documents)
    expect(reply).toMatchObject({
      ok: true,
      solved: true,
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

  it('passes the per-feature deltas through when the solve measured them', () => {
    const documents = new DocHandleStore()
    const featureDeltas = [{
      id: 'sk1', kind: 'sketch', status: 'fully_constrained',
      volume: 0, bbox: null, volumeDelta: 0, bboxDelta: null,
    }]
    expect(runReply({ ...source, featureDeltas }, false, documents).featureDeltas).toEqual(featureDeltas)
  })

  it('names the document length unit on every reply, mm by default', () => {
    const documents = new DocHandleStore()
    expect(runReply(source, false, documents).length_unit).toBe('mm')

    const inch = { ...doc('sk1'), length_unit: 'inch' } as PartDoc
    const inchReply = runReply({ ...source, doc: inch, docHash: docHashOf(inch) }, false, documents)
    expect(inchReply.length_unit).toBe('inch')
  })

  it('omits an empty frames map and carries a non-empty one', () => {
    const documents = new DocHandleStore()
    expect(runReply({ ...source, frames: {} }, false, documents).frames).toBeUndefined()
    expect(runReply({ ...source, frames: null }, false, documents).frames).toBeUndefined()

    const frames = {
      sk1: { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] },
    }
    expect(runReply({ ...source, frames }, false, documents).frames).toEqual(frames)
  })

  it('always carries features, and the summary names them only when there are problems', () => {
    const documents = new DocHandleStore()
    expect(runReply(source, false, documents).features).toEqual([])
    expect(runReply(source, false, documents).summary).not.toContain('problems:')

    const problem = {
      id: 'h1',
      kind: 'hole',
      status: 'exception',
      message: "hole: sketch 'sk3' has no point entities; the hole needs a point in its sketch to drill",
    }
    const failed = runReply({ ...source, features: [problem] }, false, documents)
    expect(failed.ok).toBe(true)
    expect(failed.features).toEqual([problem])
    expect(failed.summary).toBe(
      "features: sk1 (sketch); bodies: body_ex1; problems: h1 (hole) exception: hole: sketch 'sk3' has no point entities; the hole needs a point in its sketch to drill",
    )
  })

  it('carries the informational notes, and omits the key when the list is empty', () => {
    const documents = new DocHandleStore()
    const notes = [{ ids: ['fi1'], text: 'fillet: the picked edges continue along the tangent chain' }]
    expect(runReply({ ...source, notes }, false, documents).notes).toEqual(notes)
    expect(runReply({ ...source, notes: [] }, false, documents)).not.toHaveProperty('notes')
    expect(runReply(source, false, documents)).not.toHaveProperty('notes')
  })

  it('says a refused first step was not solved and never lists a consumed body', () => {
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
    // A refused step 0: no mutation landed, so no settle was attempted and the
    // reply has no live set to name. The part_style fallback would list bodies
    // of a document that was never built.
    const refused = runReply({
      ...source,
      ok: false,
      solved: false,
      doc: consumed,
      docHash: docHashOf(consumed),
      bodies: null,
      outcome: {
        steps: [
          { index: 0, ok: false, error: { code: 'duplicate-id', message: 'feature id already exists' } },
        ],
      },
    }, false, new DocHandleStore())
    expect(refused.summary).toContain('bodies: not solved (step 0 refused)')
    expect(refused.summary).not.toContain('body_ex2')
    expect(refused.ok).toBe(false)
    expect(refused.solved).toBe(false)
  })

  it('a refused step after an accepted one reports the live prefix', () => {
    const built = {
      version: 1,
      kind: 'part',
      features: [
        { id: 'sk1', kind: 'sketch' },
        { id: 'ex1', kind: 'extrude' },
      ],
    } as unknown as PartDoc
    const refused = runReply({
      ...source,
      ok: false,
      doc: built,
      docHash: docHashOf(built),
      bodies: ['body_ex1'],
      outcome: {
        steps: [
          { index: 0, ok: true },
          { index: 1, ok: false, error: { code: 'unknown-command', message: 'unknown command "noop"' } },
        ],
      },
    }, false, new DocHandleStore())
    expect(refused.summary).toContain('body_ex1')
    expect(refused.summary).toContain('solved through step 0; step 1 refused, not applied')
    expect(refused.summary).not.toContain('not solved')
    expect(refused.solved).toBe(true)
  })

  it('words a stalled step as a timeout, never a refusal', () => {
    const built = doc('sk1')
    const timedOut = runReply({
      ...source,
      ok: false,
      doc: built,
      docHash: docHashOf(built),
      bodies: ['body_ex1'],
      outcome: {
        steps: [
          { index: 0, ok: true },
          { index: 1, ok: false, error: { code: 'solve-timeout', message: 'solve timed out after 30 s in feature ex1' } },
        ],
      },
    }, false, new DocHandleStore())
    expect(timedOut.summary).toContain('step 1 timed out')
    expect(timedOut.summary).not.toContain('refused')
    expect(timedOut.summary).toContain('body_ex1')
  })
})

describe('selectReply', () => {
  function resultOf(count: number): SelectResult {
    const items = Array.from({ length: count }, (_, index) => ({
      query: `?edge_${index}`,
      kind: 'edge' as const,
      body: 'body_ex1',
      index,
      geometry: { kind: 'line', length: 10 },
    }))
    return { queries: items.map(item => item.query), items }
  }

  it('queries returns count and the queries without an items key', () => {
    const result = resultOf(128)
    const reply = selectReply('docHash1', result, 'queries')
    expect(reply).toEqual({ ok: true, docHash: 'docHash1', count: 128, queries: result.queries })
    expect('items' in reply).toBe(false)
  })

  it('full returns count with the items, and an omitted detail is full', () => {
    const result = resultOf(128)
    const full = selectReply('docHash1', result, 'full')
    expect(full.count).toBe(128)
    expect(full.queries).toHaveLength(128)
    expect(full.items).toHaveLength(128)
    expect(selectReply('docHash1', result)).toEqual(full)
  })

  it('preserves the engine query order', () => {
    const result = resultOf(3)
    result.queries = ['third', 'first', 'second']
    expect(selectReply('h', result, 'queries').queries).toEqual(['third', 'first', 'second'])
  })

  it('does not mutate the engine result a non-MCP caller reuses', () => {
    const result = resultOf(4)
    selectReply('h', result, 'queries')
    expect(result.queries).toHaveLength(4)
    expect(result.items).toHaveLength(4)
  })
})

describe('resolveDoc for assemblies', () => {
  const rail = doc('rail')

  function assembly(handle = 'left'): AssemblyDoc {
    return {
      version: 1,
      kind: 'assembly',
      features: [{ id: `inst_${handle}`, kind: 'part_instance', instance: {
        handle, doc_id: 'rail', doc_rev: 0, transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
      } }],
    }
  }

  it('refuses a raw assembly doc with no binding, naming the unbound ids', () => {
    const resolved = resolveDoc({ doc: assembly() }, new DocHandleStore())
    expect(resolved.ok).toBe(false)
    if (resolved.ok) throw new Error('unreachable')
    expect(resolved.error).toContain('unbound part(s): rail')
    expect(resolved.error).toContain('bound parts: none')
  })

  it('binds a raw assembly doc and mints the composite handle', () => {
    const store = new DocHandleStore()
    const resolved = resolveDoc({ doc: assembly(), parts: { rail: { doc: rail } } }, store)
    expect(resolved).toMatchObject({ ok: true, kind: 'assembly' })
    if (!resolved.ok || resolved.kind !== 'assembly') throw new Error('unreachable')
    expect(resolved.docHash).toBe(assemblyHandleOf({ ...assembly(), version: CURRENT_DOC_VERSION }, { rail }))
    expect(store.getEntry(resolved.docHash)).toMatchObject({ kind: 'assembly' })
  })

  it('merges a parts override on an assembly handle into a new hash', () => {
    const store = new DocHandleStore()
    const first = resolveDoc({ doc: assembly(), parts: { rail: { doc: rail } } }, store)
    if (!first.ok || first.kind !== 'assembly') throw new Error('unreachable')
    const edited = doc('rail-edited')
    const merged = resolveDoc({ docHash: first.docHash, parts: { rail: { doc: edited } } }, store)
    expect(merged).toMatchObject({ ok: true, kind: 'assembly' })
    if (!merged.ok || merged.kind !== 'assembly') throw new Error('unreachable')
    expect(merged.docHash).not.toBe(first.docHash)
    expect(merged.parts.rail).toEqual({ ...edited, version: CURRENT_DOC_VERSION })
  })

  it('refuses a bound hash that names an assembly', () => {
    const store = new DocHandleStore()
    const inner = resolveDoc({ doc: assembly(), parts: { rail: { doc: rail } } }, store)
    if (!inner.ok) throw new Error('unreachable')
    const outer = resolveDoc({ doc: assembly('right'), parts: { rail: inner.docHash } }, store)
    expect(outer.ok).toBe(false)
    if (outer.ok) throw new Error('unreachable')
    expect(outer.error).toContain('an assembly cannot be a part')
  })

  it('refuses parts on a part document', () => {
    const resolved = resolveDoc({ doc: doc('sk1'), parts: { rail: { doc: rail } } }, new DocHandleStore())
    expect(resolved.ok).toBe(false)
    if (resolved.ok) throw new Error('unreachable')
    expect(resolved.error).toContain('applies only to an assembly')
  })

  it('requirePartDoc refuses an assembly handle with the part-handle hint', () => {
    const store = new DocHandleStore()
    const resolved = resolveDoc({ doc: assembly(), parts: { rail: { doc: rail } } }, store)
    if (!resolved.ok) throw new Error('unreachable')
    const part = requirePartDoc(resolved, 'select')
    expect(part.ok).toBe(false)
    if (part.ok) throw new Error('unreachable')
    expect(part.error).toContain("select runs on a part document; pass the part's docHash")
    expect(part.error).toContain('parts')
  })
})
