// Drift guard for the face-frame documentation in docs/drive.md (MCP Server).
// The table is checked against normalToFrame through faceFrameRows, never
// against a hand-typed copy, so a change to the frame rule cannot leave the
// docs describing the old quarter turn. When this fails, fix the doc.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { faceFrameRows } from '../worldFrame'

const DOC_PATH = join(__dirname, '../../../../docs/drive.md')
const DOC = readFileSync(DOC_PATH, 'utf8')

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
    const modes = [
      'offset', 'three_point', 'plane_point', 'line_angle',
      'on_face', 'on_face_edge_angle', 'edge_point',
    ]
    const missing = modes.filter(mode => !DOC.includes(`- \`${mode}\`: `))
    expect(missing).toEqual([])
  })
})
