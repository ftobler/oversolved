// @vitest-environment node
//
// The assembly `out` contract on the wire: a bare YAML/JSON path still writes
// the assembly document but carries the note naming the part documents it
// cannot resolve, the zip path resolves every instance, and an assembly path
// with no extension defaults to that zip. A part document keeps its own rule
// and its `.zip` refusal.

import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { readZipFiles, readZipTree } from '@/workspace/zipCarrier'
import { readZipBag, importBag } from '@/workspace/import'
import { IdbWorkspaceStore } from '@/workspace/store'
import { resetWorkspaceIdb } from '@/workspace/__tests__/idbHarness'
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

const PIN_STEPS = [
  { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Pin', plane: '@builtin_plane_front' } },
  { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'circle', params: [0, 0, 5], entityId: 'c1', dimensions: true } },
  { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:c1:center', '@builtin_origin'] } },
  { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Pin', sketchQuery: '$sk1', distance: 20, operation: 'new' } },
]

async function initialize(client: ReturnType<typeof spawnMcp>) {
  return client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcpAssemblyOut', version: '0' },
  })
}

type Note = { ids: string[]; text: string }

describe.skipIf(!oc || !solveBytes || !stripTypes)('MCP assembly out (real OCC + mate solver)', () => {
  beforeEach(resetWorkspaceIdb)

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
      // reply's structured note names the part document that cannot resolve.
      const bareFile = path.join(OUT_DIR, 'bare.json')
      const bare = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: assemblyHash, steps: [], out: bareFile },
      }))
      expect(bare).toMatchObject({ ok: true, file: bareFile, format: 'json' })
      const notes = bare.notes as Note[]
      expect(notes).toHaveLength(1)
      expect(notes[0].ids).toEqual(['plate'])
      expect(notes[0].text).toContain('part document plate')
      expect(notes[0].text).toContain('part_instance')
      expect(notes[0].text).toContain('.zip')
      const bareDoc = JSON.parse(readFileSync(bareFile, 'utf8')) as {
        kind: string
        features: Array<{ kind: string; instance?: { doc_id: string } }>
      }
      expect(bareDoc.kind).toBe('assembly')
      expect(bareDoc.features.find(feature => feature.kind === 'part_instance')!.instance!.doc_id).toBe('plate')

      // returnDoc is unchanged by the out rule: the document still rides the
      // reply, and the file it also wrote carries the same note.
      const withDoc = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: assemblyHash, steps: [], returnDoc: true, out: path.join(OUT_DIR, 'with-doc.json') },
      }))
      expect((withDoc.doc as { kind: string }).kind).toBe('assembly')
      expect((withDoc.notes as Note[])[0]).toMatchObject({ ids: ['plate'] })

      // An explicit .yaml carries the same note.
      const bareYaml = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: assemblyHash, steps: [], out: path.join(OUT_DIR, 'bare.yaml') },
      }))
      expect(bareYaml).toMatchObject({ ok: true, format: 'yaml' })
      expect((bareYaml.notes as Note[])).toHaveLength(1)

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

      // The extension reads in either case, so an uppercase .ZIP is still the zip.
      const upperFile = path.join(OUT_DIR, 'upper.ZIP')
      const upper = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: assemblyHash, steps: [], out: upperFile },
      }))
      expect(upper).toMatchObject({ ok: true, file: upperFile, format: 'zip' })
      expect(upper.bytes as number).toBeGreaterThan(0)

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

      for (const zipOut of ['part.zip', 'part-upper.ZIP']) {
        const refused = errorPayload(await client.request('tools/call', {
          name: 'run',
          arguments: { docHash: plateHash, steps: [], out: path.join(OUT_DIR, zipOut) },
        }))
        expect(String(refused.error)).toContain('a workspace zip needs an assembly document')
      }
    } finally {
      await client.close()
    }
  }, 240_000)

  it('defaults an assembly path with no extension to the workspace zip', async () => {
    mkdirSync(OUT_DIR, { recursive: true })
    const client = spawnMcp()
    try {
      await initialize(client)

      const plate = toolPayload(await client.request('tools/call', { name: 'run', arguments: { steps: PLATE_STEPS } }))
      const pin = toolPayload(await client.request('tools/call', { name: 'run', arguments: { steps: PIN_STEPS } }))
      const assembly = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: {
          kind: 'assembly',
          parts: { plate: plate.docHash, pin: pin.docHash },
          steps: [
            { mutation: { type: 'add_part', handle: 'plate', part: 'plate', fixed: true } },
            { mutation: { type: 'add_part', handle: 'pin', part: 'pin', position: [30, 30, 40] } },
          ],
        },
      }))
      const assemblyHash = assembly.docHash as string

      // No extension means the zip, the reply names the path it wrote, and the
      // archive holds exactly the manifest, the assembly and one document per
      // bound part.
      const defaultFile = path.join(OUT_DIR, 'default')
      const defaulted = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: assemblyHash, steps: [], out: defaultFile },
      }))
      expect(defaulted).toMatchObject({ ok: true, file: `${defaultFile}.zip`, format: 'zip' })
      expect(defaulted.bytes as number).toBeGreaterThan(0)
      expect(defaulted.notes).toBeUndefined()
      const bytes = new Uint8Array(readFileSync(`${defaultFile}.zip`))
      expect((await readZipFiles(bytes)).map(file => file.path).sort()).toEqual([
        '.oversolved-manifest.yaml',
        'documents/assembly.yaml',
        'documents/pin.yaml',
        'documents/plate.yaml',
      ])

      // The written archive round-trips through the browser's own import path:
      // every part_instance.doc_id resolves to a live part entry.
      const store = new IdbWorkspaceStore()
      const imported = await importBag(await readZipBag(bytes, 'zip'), { origin: 'zip' }, store)
      expect(imported.mode).toBe('new')
      expect(imported.documents).toBe(3)
      for (const docId of ['plate', 'pin']) {
        const opened = await store.readEntry(imported.workspace, docId)
        expect(opened.kind).toBe('document')
        expect(opened.docKind).toBe('part')
      }

      // A directory-style path takes the same default.
      const dirStyle = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: assemblyHash, steps: [], out: path.join(OUT_DIR, 'dir') + '/' },
      }))
      expect(dirStyle).toMatchObject({ ok: true, file: path.join(OUT_DIR, 'dir.zip'), format: 'zip' })

      // A path that already holds a pre-change document gains .zip beside it:
      // the old file is left alone rather than overwritten.
      const legacy = path.join(OUT_DIR, 'legacy')
      const legacyText = 'version: 3\nkind: assembly\n'
      writeFileSync(legacy, legacyText)
      const migrated = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: assemblyHash, steps: [], out: legacy },
      }))
      expect(migrated).toMatchObject({ ok: true, file: `${legacy}.zip`, format: 'zip' })
      expect(readFileSync(legacy, 'utf8')).toBe(legacyText)

      // A path that is an existing directory writes its .zip sibling instead of
      // treating the directory as the archive.
      const existingDir = path.join(OUT_DIR, 'existing-dir')
      mkdirSync(existingDir, { recursive: true })
      const fromDir = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: assemblyHash, steps: [], out: existingDir },
      }))
      expect(fromDir).toMatchObject({ ok: true, file: `${existingDir}.zip`, format: 'zip' })
      expect(existsSync(`${existingDir}.zip`)).toBe(true)
      expect(statSync(existingDir).isDirectory()).toBe(true)
    } finally {
      await client.close()
    }
  }, 240_000)
})
