// The keeps-body register: every place the code still says body, with why.
//
// The product vocabulary is part. This register is the only place the word
// body is allowed to survive in a declaration or a file name, and each entry
// is a stored key, a wire field, a fixture shape or a third-party name that a
// rename would migrate or break. `partNaming.test.ts` fails on a body
// declaration that is not listed here. Add a stored key here with its reason;
// name a user part `part`.
//
// File patterns are relative to `src/` and use `**` for any directory depth
// and `*` for one path segment.

/** The declaration a register entry covers. */
export type PartNamingKind =
  | 'variable'
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'enumMember'
  | 'parameter'
  | 'property'
  | 'method'
  | 'binding'
  | 'typeParameter'
  | 'file'

export interface PartNamingKeep {
  // The exact identifier, or the file's basename for kind `file`.
  name: string
  // Kinds the entry covers; absent means every kind.
  kinds?: readonly PartNamingKind[]
  // Files the entry covers; absent means every file.
  files?: readonly string[]
  // Why the word stays: the stored key, the wire field, the DOM, ...
  reason: string
}

// Formats that are stored, cached or handed across the worker or MCP boundary.
// Their property names are spelled in the data, not in the code, so a rename
// here is a storage or wire migration.
const WIRE_FILES = [
  'types/cad.ts',
  'kernel/types3d.ts',
  'kernel/builderTypes.ts',
  'kernel/worker/solverProtocol.ts',
  'kernel/partBundle.ts',
  'drive/driveSurface.ts',
  'drive/headlessOps.ts',
  'drive/headlessPart.ts',
  'drive/mcpDocRef.ts',
  'drive/headlessAssembly.ts',
  'drive/solveWriteBack.ts',
  'drive/featureDeltas.ts',
  'drive/mcpServer.ts',
  'drive/kernelWorker.ts',
  'drive/featureOutcome.ts',
  'kernel/solveAssembly.ts',
  'regressions/corpus.ts',
  'oracle/corpus.ts',
  'testing/robustnessFuzz/chain.ts',
  'testing/robustnessFuzz/recipe.ts',
  'utils/yamlMigrations.ts',
  'utils/yamlMutations/featureDefs.ts',
] as const

// Test fixtures build document literals and wire payloads by hand, so a local
// interface property that mirrors a stored key must keep the key's spelling.
const TEST_FILES = ['**/__tests__/**', '**/*.test.ts', '**/*.test.tsx'] as const

const STORED_PROPERTY_FILES = [...WIRE_FILES, ...TEST_FILES]

export const PART_NAMING_KEEP: readonly PartNamingKeep[] = [
  {
    name: 'body',
    kinds: ['property'],
    files: STORED_PROPERTY_FILES,
    reason: 'stored key: the mirror feature def and the delete_body/transform def share the singular body pick the loader migrations read',
  },
  {
    name: 'bodies',
    kinds: ['property'],
    files: STORED_PROPERTY_FILES,
    reason: 'stored and wire key: feature pick lists, the solve BuildResponse, the PartBundle cache and the drive/MCP inspect reply',
  },
  {
    name: 'bodies',
    kinds: ['property'],
    files: ['kernel/occ/measure.ts', 'kernel/occ/measureTolerance.ts'],
    reason: 'measure result and expectation field: the oracle, drive and regression manifest count bodies under this key (frontend/scripts/regressions.ts reads it)',
  },
  {
    name: 'perBody',
    kinds: ['property'],
    files: ['kernel/occ/measure.ts'],
    reason: 'MCP and CLI measure output field: the per-body rows of the measure reply',
  },
  {
    name: 'bodyA',
    kinds: ['property'],
    files: ['kernel/solveAssembly.ts'],
    reason: 'mate solver rigid-body index: the Rust mate ABI names its two bodies A and B, and the record mirrors it',
  },
  {
    name: 'bodyB',
    kinds: ['property'],
    files: ['kernel/solveAssembly.ts'],
    reason: 'mate solver rigid-body index beside bodyA',
  },
  {
    name: 'body_id',
    kinds: ['property'],
    reason: 'wire result field: FeaturePartsResult and the solve write-back report the part a feature made',
  },
  {
    name: 'body_ids',
    kinds: ['property'],
    reason: 'wire result field: every body a feature made, body_id being the first',
  },
  {
    name: 'source_body',
    kinds: ['property'],
    reason: 'stored feature key of the pattern, mirror and wrap sources',
  },
  {
    name: 'target_body',
    kinds: ['property'],
    reason: 'stored feature key of the pattern and mirror merge target',
  },
  {
    name: 'delete_body',
    kinds: ['property'],
    reason: 'stored feature sub-def key and the delete_body feature kind spelling',
  },
  {
    name: 'pick_bodies',
    kinds: ['property'],
    reason: 'wire key of the solve checkpoint and BuildResponse pick-result map',
  },
  {
    name: 'body_store_snapshot',
    kinds: ['property'],
    reason: 'worker checkpoint payload key: the per-feature body store handed through _build_state',
  },
  {
    name: 'bodies_snapshot',
    kinds: ['property'],
    reason: 'worker checkpoint payload key beside body_store_snapshot',
  },
  {
    name: 'deleted_body_ids',
    kinds: ['property'],
    reason: 'feature result field the delete_body leaf reports to the builder',
  },
  {
    name: 'bodyId',
    kinds: ['property'],
    files: [
      'types/cad.ts',
      'kernel/worker/solverProtocol.ts',
      'drive/kernelWorker.ts',
      'drive/featureOutcome.ts',
      'utils/partExport.ts',
      'kernel/solveLocally.ts',
      'hooks/mutationIdempotence.ts',
    ],
    reason: 'mutation and worker field: the drive/MCP mutation catalog names a stored part with bodyId, and the kernel host reports it',
  },
  {
    name: 'bodyIds',
    kinds: ['property'],
    files: ['kernel/worker/solverProtocol.ts', 'utils/partExport.ts', 'kernel/solveLocally.ts'],
    reason: 'worker protocol field carrying every part a result names; the export options and the drive CLI share the spelling',
  },
  {
    name: 'bodyQuery',
    kinds: ['property'],
    files: ['types/cad.ts'],
    reason: 'drive/MCP mutation field of the add_*_body_ref and add_*_body mutations',
  },
  {
    name: 'bodyVolume',
    kinds: ['property'],
    files: ['drive/featureDeltas.ts'],
    reason: 'drive/MCP feature delta field: the volume of the part a feature changed',
  },
  {
    name: 'changedBodyCount',
    kinds: ['property'],
    files: ['drive/featureDeltas.ts'],
    reason: 'drive/MCP feature delta field: how many live parts the feature changed',
  },
  {
    name: 'PlaneBody',
    kinds: ['function', 'variable'],
    files: [
      'components/Viewport/PlaneBody.tsx',
      'components/Viewport/ReferencePlane.tsx',
      'components/Viewport/UserDefinedPlane.tsx',
    ],
    reason: 'a plane mesh, not a user part: the component is the shared visual for datum and user planes, and the plane components lazy-load it under its own name',
  },
  {
    name: 'PlaneBody.tsx',
    kinds: ['file'],
    files: ['components/Viewport/PlaneBody.tsx'],
    reason: 'file of the plane-mesh component above, named after the plane body it draws',
  },
  {
    name: 'PlaneBody.test.tsx',
    kinds: ['file'],
    files: ['components/Viewport/__tests__/PlaneBody.test.tsx'],
    reason: 'test of the plane-mesh component, whose file keeps its name',
  },
  {
    name: 'PlaneBody',
    kinds: ['variable'],
    files: ['components/Viewport/__tests__/PlaneBody.test.tsx'],
    reason: 'the test lazy-loads the plane-mesh component under its own name',
  },
  {
    name: 'buildBaselineBody',
    kinds: ['function'],
    files: ['wasm-kernel/baselineBody.ts'],
    reason: 'imported by frontend/scripts/regenCorpus.ts, which this refactor must not touch',
  },
  {
    name: 'baselineBody.ts',
    kinds: ['file'],
    files: ['wasm-kernel/baselineBody.ts'],
    reason: 'the module frontend/scripts/regenCorpus.ts imports buildBaselineBody from',
  },
  {
    name: 'feature-delete-body.svg',
    kinds: ['file'],
    files: ['assets/icons/feature-delete-body.svg'],
    reason: 'generated by oversolved/icons; the icon id is referenced outside the frontend tree',
  },
]
