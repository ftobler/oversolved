// Drift guard for the face-frame and add_plane-frame documentation the MCP
// surface serves (docs/drive.md, MCP Server). The face table is checked against
// normalToFrame through faceFrameRows, and the mode list against the plane
// schema the catalog serves, so a new mode or a changed frame rule cannot leave
// the docs and the initialize sentence describing the old convention. When this
// fails, fix the doc or the sentence, not this file.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { planeDefinitionSchema } from '@/persistence/partDocSchema'
import { addPlaneFrameModes, addPlaneFrameSentence, faceFrameRows } from '../worldFrame'

const DOC_PATH = join(__dirname, '../../../../docs/drive.md')
const DOC = readFileSync(DOC_PATH, 'utf8')

/** The mode names the part-document schema accepts for a plane definition. */
function schemaPlaneModes(): string[] {
  const properties = planeDefinitionSchema().properties as
    { mode?: { enum?: unknown } } | undefined
  const modes = properties?.mode?.enum
  if (!Array.isArray(modes)) throw new Error('the plane definition schema has no mode enum')
  return modes.map(String)
}

/** The markdown rows under the face-frame table header, cells trimmed. */
function tableRows(): string[][] {
  const lines = DOC.split('\n')
  const header = lines.findIndex(line => line.trim() === '| face normal | sketch x | sketch y |')
  expect(header, 'docs/drive.md has no face-frame table').toBeGreaterThanOrEqual(0)
  const rows: string[][] = []
  for (let i = header + 2; i < lines.length; i++) {  // +2 skips the separator row
    const line = lines[i].trim()
    if (!line.startsWith('|')) break
    rows.push(line.split('|').slice(1, -1).map(cell => cell.trim()))
  }
  return rows
}

describe('docs/drive.md face frames', () => {
  it('checks the six-normal table against normalToFrame', () => {
    const served = faceFrameRows().map(row => [row.normal, row.xAxis, row.yAxis])
    expect(tableRows()).toEqual(served)
  })

  it('states the origin rule and the read-it-from-the-reply advice', () => {
    expect(DOC).toContain('origin at the face centroid')
    expect(DOC).toContain('Read the frame from the reply')
    expect(DOC).toContain('`frames`')
  })

  it('gives a frame convention for every add_plane mode the schema accepts', () => {
    const modes = schemaPlaneModes()
    expect(modes.length).toBeGreaterThan(0)
    // The sentence the server serves and the docs say the same set of modes.
    expect([...addPlaneFrameModes()].sort()).toEqual([...modes].sort())
    expect(modes.filter(mode => !DOC.includes(`- \`${mode}\`: `))).toEqual([])
    expect(modes.filter(mode => !addPlaneFrameSentence().includes(`${mode}: `))).toEqual([])
  })
})
