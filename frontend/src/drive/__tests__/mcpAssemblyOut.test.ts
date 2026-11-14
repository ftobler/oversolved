// @vitest-environment node
//
// The assembly `out` contract on the wire: a bare YAML/JSON path still writes
// the assembly document but carries the note naming the part documents it
// cannot resolve, while the zip path resolves every instance. A part document
// keeps its own rule and its `.zip` refusal.

import { describe, it, expect } from 'vitest'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { readZipTree } from '@/workspace/zipCarrier'
import { errorPayload, spawnMcp, TMP_DIR, toolPayload } from './mcpStdioClient'

const OUT_DIR = path.join(TMP_DIR, 'assembly-mcp-out')

function occInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('opencascade.js/dist/opencascade.wasm.js')
    return true
  } catch {
    return false
  }
}

const oc = occInstalled()
const solveBytes = loadSolver()
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
const stripTypes = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6)

const PLATE_STEPS = [
  { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Plate', plane: '@builtin_plane_front' } },
  { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [100, 60], p0Ref: '@builtin_origin', dimensions: true } },
  { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Plate', sketchQuery: '$sk1', distance: 10, operation: 'new' } },
]

async function initialize(client: ReturnType<typeof spawnMcp>) {
  return client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcpAssemblyOut', version: '0' },
  })
}

describe.skipIf(!oc || !solveBytes || !stripTypes)('MCP assembly out (real OCC + mate solver)', () => {
  it('warns on a bare assembly file and leaves the zip and part rules alone', async () => {
    mkdirSync(OUT_DIR, { recursive: true })
    const client = spawnMcp()
    try {
      await initialize(client)

      const plate = toolPayload(await client.request('tools/call', { name: 'run', arguments: { steps: PLATE_STEPS } }))
      const plateHash = plate.docHash as string
      const assembly = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: {
          kind: 'assembly',
          parts: { plate: plateHash },
          steps: [{ mutation: { type: 'add_part', handle: 'plate', part: 'plate', fixed: true } }],
        },
      }))
      expect(assembly.ok).toBe(true)
      const assemblyHash = assembly.docHash as string

      // An explicit .json is the assembly document alone: written, and the
      // reply names the part document whose doc_id cannot resolve from it.
      const bareFile = path.join(OUT_DIR, 'bare.json')
      const bare = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: assemblyHash, steps: [], out: bareFile },
      }))
      expect(bare).toMatchObject({ ok: true, file: bareFile, format: 'json' })
      expect(bare.notes).toHaveLength(1)
      const note = (bare.notes as string[])[0]
      expect(note).toContain('plate')
      expect(note).toContain('part_instance')
      expect(note).toContain('.zip')
      const bareDoc = JSON.parse(readFileSync(bareFile, 'utf8')) as {
        kind: string
        features: Array<{ kind: string; instance?: { doc_id: string } }>
      }
      expect(bareDoc.kind).toBe('assembly')
      expect(bareDoc.features.find(feature => feature.kind === 'part_instance')!.instance!.doc_id).toBe('plate')

      // An explicit .yaml carries the same note.
      const bareYaml = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: assemblyHash, steps: [], out: path.join(OUT_DIR, 'bare.yaml') },
      }))
      expect(bareYaml).toMatchObject({ ok: true, format: 'yaml' })
      expect(bareYaml.notes).toHaveLength(1)

      // The zip is self-contained, so it has nothing to warn about and lands
      // the assembly plus the bound part at their workspace paths.
      const zipFile = path.join(OUT_DIR, 'bundle.zip')
      const zipped = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: assemblyHash, steps: [], out: zipFile },
      }))
      expect(zipped).toMatchObject({ ok: true, format: 'zip' })
      expect(zipped.notes).toBeUndefined()
      const zipPaths = Object.values((await readZipTree(new Uint8Array(readFileSync(zipFile)))).manifest.entries)
        .map(row => row.path)
      expect(zipPaths).toEqual(expect.arrayContaining([
        'documents/assembly.yaml',
        'documents/plate.yaml',
      ]))

      // An assembly with no instances has nothing to leave behind.
      const empty = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { kind: 'assembly', steps: [], out: path.join(OUT_DIR, 'empty.json') },
      }))
      expect(empty.ok).toBe(true)
      expect(empty.notes).toBeUndefined()

      // A part run keeps YAML/JSON by extension, and an extensionless path is
      // still YAML rather than a zip.
      const partJson = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: plateHash, steps: [], out: path.join(OUT_DIR, 'part.json') },
      }))
      expect(partJson).toMatchObject({ ok: true, format: 'json' })
      expect(partJson.notes).toBeUndefined()
      const partPlain = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: plateHash, steps: [], out: path.join(OUT_DIR, 'part-noext') },
      }))
      expect(partPlain).toMatchObject({ ok: true, file: path.join(OUT_DIR, 'part-noext'), format: 'yaml' })

      const refused = errorPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: plateHash, steps: [], out: path.join(OUT_DIR, 'part.zip') },
      }))
      expect(String(refused.error)).toContain('a workspace zip needs an assembly document')
    } finally {
      await client.close()
    }
  }, 240_000)
})
