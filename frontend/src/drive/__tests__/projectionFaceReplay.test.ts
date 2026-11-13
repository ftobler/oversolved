// @vitest-environment node
//
// Replay of a document that holds a face projection: the journal records the
// derived member map with the add, so a replay needs no live solve; a freeze
// carries its member rows in the delete payload; and the derived ids never
// consume the journal's mint index, so a later `add_entity` keeps its id.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import { createHeadlessPart } from '../headlessPart'
import { createDriveJournal, type CommandJournal } from '../journal'
import { replayJournal } from '../replay'
import { docHashOf } from '../docHash'
import type { ScriptStep } from '../scriptRunner'
import { deriveMemberIds, faceBoundaryFromBodies, faceProjectionConstraintId } from '@/kernel/features/projectionMembers'
import type { PartDoc } from '@/types/cad'
import {
  BOX_BODY_ID, BOX_SKETCH_ID, oc, projectionBaseDoc, projectionTestHarness, solveBytes,
} from '@/kernel/features/__tests__/projectionRealSupport'

const { h, base } = projectionTestHarness()

interface FaceFixture {
  frontFace: string
  cid: string
  member: string
  steps: ScriptStep[]
}

/** The face query, its derived constraint id, and one line member id, all read
 *  from the one base build by geometry. */
function faceFixture(): FaceFixture {
  const { result, geometry } = base()
  const body = h.body(result, BOX_BODY_ID)
  const boundary = faceBoundaryFromBodies(() => ({ [BOX_BODY_ID]: body }))(geometry.frontFace)
  if (!boundary) throw new Error('base body: front face has no boundary')
  const cid = faceProjectionConstraintId(geometry.frontFace)
  if (cid === null) throw new Error('front face query carries no construction UUID')
  const ids = deriveMemberIds(cid, boundary.edges.map(edge => edge.token))
  const line = boundary.edges.find(edge => edge.kind === 'line')
  if (!line) throw new Error('base body: front face has no straight edge')
  const steps: ScriptStep[] = [
    { mutation: { type: 'add_sketch', featureId: 'skP', label: 'Projection', plane: '@builtin_plane_front' } },
    { mutation: { type: 'add_projected_entity', featureId: 'skP', source: geometry.frontFace } },
    { mutation: { type: 'set_constraint_value', featureId: BOX_SKETCH_ID, constraintId: 'c9', value: 50 } },
    {
      mutation: {
        type: 'add_entity_with_constraint', featureId: 'skP', kind: 'point', params: [5, 5],
        vertexKey: 'xy', snapVertexId: `vertex:skP:${ids[line.token]}:start`, constraintKind: 'coincident',
      },
    },
  ]
  return { frontFace: geometry.frontFace, cid, member: ids[line.token], steps }
}

function part(doc: PartDoc = projectionBaseDoc(), journal?: CommandJournal) {
  return createHeadlessPart({ doc: structuredClone(doc), docId: 'face-replay', ...(journal && { journal }) })
}

const mintedPointId = (doc: PartDoc | null): string => {
  const sketch = (doc?.features ?? []).find(f => f.id === 'skP')
  if (sketch?.kind !== 'sketch') throw new Error('no projection sketch')
  const point = sketch.entities?.find(e => e.kind === 'point')
  if (!point) throw new Error('no minted point')
  return point.id
}

describe.skipIf(!oc || !solveBytes)('face projection replay', () => {
  it('18. a face add, an upstream width edit, a member constraint and a freeze replay without divergence', async () => {
    const fixture = faceFixture()
    const journal = createDriveJournal(projectionBaseDoc())
    const recorded = part(projectionBaseDoc(), journal)
    const outcome = await recorded.run(fixture.steps)
    expect(outcome.ok).toBe(true)

    // Freeze the projection: the delete carries the member row bytes, so the
    // replay writes the same rows without solving.
    const frozen = recorded.session.execute({
      type: 'delete',
      targets: [`constraint:skP:${fixture.cid}`],
      materialize: [{ id: fixture.member, kind: 'line', params: [0, 0, 10, 0] }],
    } as never)
    expect(frozen.ok).toBe(true)

    const repro = journal.repro()
    expect(repro).not.toBeNull()
    const fresh = part(repro!.doc as PartDoc)
    const replay = await replayJournal(repro!, fresh.session, () => fresh.idle())
    expect(replay.ok).toBe(true)
    expect(replay.steps.every(step => step.ok)).toBe(true)
    expect(replay.finalHash).toBe(docHashOf(recorded.getDoc() as PartDoc))
  })

  it('19. one settle for the whole script and one settle per step reach the same document', async () => {
    const fixture = faceFixture()
    const whole = part()
    expect((await whole.run(fixture.steps)).ok).toBe(true)

    const chunked = part()
    for (const step of fixture.steps) {
      expect((await chunked.run([step])).ok).toBe(true)
    }
    expect(docHashOf(chunked.getDoc() as PartDoc)).toBe(docHashOf(whole.getDoc() as PartDoc))
  })

  it('20. a later add_entity keeps its minted id: members never consume the mint index', async () => {
    const fixture = faceFixture()
    // A plain add_entity after the projection mints from the same sequence the
    // face constraint would have consumed if it used a mint; the id recorded is
    // the one replay hands out again. The control run's seed differs with the
    // authored document, so the comparison is record vs replay.
    const journal = createDriveJournal(projectionBaseDoc())
    const recorded = part(projectionBaseDoc(), journal)
    expect((await recorded.run([
      fixture.steps[0],
      fixture.steps[1],
      { mutation: { type: 'add_entity', featureId: 'skP', kind: 'point', params: [8, 8] } },
    ])).ok).toBe(true)
    const repro = journal.repro()!
    const fresh = part(repro.doc as PartDoc)
    const replay = await replayJournal(repro, fresh.session, () => fresh.idle())
    expect(replay.ok).toBe(true)
    expect(mintedPointId(fresh.getDoc())).toBe(mintedPointId(recorded.getDoc()))
  })
})
